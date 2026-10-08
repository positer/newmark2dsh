"""X11 desktop host: per-UID flock leases, authenticated Xvfb and live window mapping.

Only X11 clients are supported. Presentation input uses XSendEvent (some applications
reject it); hidden desktop input uses XTEST on the private server, never WSLg's pointer.
The stdin pipe is the owner-lifetime signal. No fixture is launched at startup.
"""
import atexit
import ctypes
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import time
import threading
import uuid

from Xlib import X, display, protocol, error as xerror
from Xlib.ext import composite
from PIL import Image
from PyQt5 import QtCore, QtGui, QtWidgets


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def run(argv, env=None):
    result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise Refusal('native_command_failed', result.stderr.strip() or str(argv[0]))
    return result.stdout.strip()


def identity(pid):
    try:
        fields = Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else fields[19]
    except (OSError, IndexError):
        return None


def option(o, snake, default=None):
    parts = snake.split('_')
    camel = parts[0] + ''.join(p.title() for p in parts[1:])
    return o.get(camel, o.get(snake, default))


def capture(d, win):
    g = win.get_geometry()
    data = win.get_image(0, 0, g.width, g.height, X.ZPixmap, 0xffffffff)
    if data is None:
        raise Refusal('capture_unavailable', 'X server did not return a drawable image')
    # Xvfb and WSLg use little-endian packed 32-bit TrueColor. Refuse unfamiliar layouts.
    if g.depth not in (24, 32) or len(data.data) != g.width * g.height * 4:
        raise Refusal('pixel_format_unsupported', 'Expected packed 24/32-bit X11 TrueColor')
    return Image.frombytes('RGB', (g.width, g.height), data.data, 'raw', 'BGRX')


def pixmap(image):
    raw = image.convert('RGB').tobytes()
    q = QtGui.QImage(raw, image.width, image.height, image.width * 3, QtGui.QImage.Format_RGB888)
    return QtGui.QPixmap.fromImage(q.copy())


class DisplaySurface(QtWidgets.QOpenGLWidget):
    """One GPU update per completed swap; no fixed 60 Hz animation timer."""
    def __init__(self, parent, flags):
        super().__init__(parent, flags)
        fmt = QtGui.QSurfaceFormat()
        fmt.setAlphaBufferSize(8)
        fmt.setSwapInterval(1)
        self.setFormat(fmt)
        self.running = True
        self.last_swap = 0.
        self.wake = QtCore.QTimer(self)
        self.wake.setSingleShot(True)
        self.wake.setTimerType(QtCore.Qt.PreciseTimer)
        self.wake.timeout.connect(self.tick)
        self.timer = self  # lifecycle compatibility: stop_virtual stops this surface
        self.frameSwapped.connect(self.next_frame)

    def next_frame(self):
        if self.running and self.isVisible():
            # Xwayland/WSLg may return swap completion before physical scanout.
            # Bound that fallback by the current output rate, not a fixed FPS cap.
            screen = self.windowHandle().screen()
            period = 1. / max(1., screen.refreshRate())
            now = time.monotonic()
            remaining = period - (now-self.last_swap)
            self.last_swap = max(now, self.last_swap+period)
            if not self.wake.isActive():
                self.wake.start(max(0, math.ceil(remaining*1000)))

    def stop(self):
        self.running = False
        self.wake.stop()

    def initializeGL(self):
        self.gl_renderer = 'unavailable'
        try:
            gl = ctypes.CDLL('libGL.so.1')
            gl.glGetString.restype = ctypes.c_char_p
            value = gl.glGetString(0x1F01)
            if value:
                self.gl_renderer = value.decode('utf-8', 'replace')
        except OSError:
            pass  # Diagnostic lookup must not break a GLES-only Qt installation.

    def render_metrics(self):
        context = self.context()
        return {'backend': 'QOpenGLWidget', 'swap_interval': context.format().swapInterval() if context else None,
                'renderer': getattr(self, 'gl_renderer', 'unavailable'),
                'pacing': 'frameSwapped/output-refresh fallback', 'fixed_fps_limit': None}


class Preview(DisplaySurface):
    def __init__(self, host):
        super().__init__(None, QtCore.Qt.FramelessWindowHint | QtCore.Qt.Tool |
                         QtCore.Qt.WindowStaysOnTopHint | QtCore.Qt.WindowDoesNotAcceptFocus)
        self.host = host
        self.setAttribute(QtCore.Qt.WA_ShowWithoutActivating)
        self.frame = QtGui.QPixmap()
        self.progress = 0.0
        self.goal = 0.0
        self.clock = time.monotonic()
        self.request_frame = threading.Event()
        self.capture_stop = threading.Event()
        self.latest = None
        # This connection belongs exclusively to the capture worker. Never share
        # the host's python-xlib connection between the GUI and a worker thread.
        old = os.environ.get('XAUTHORITY')
        os.environ['XAUTHORITY'] = host.virtual_env['XAUTHORITY']
        try:
            connection = display.Display(host.virtual_env['DISPLAY'])
        finally:
            if old is None:
                os.environ.pop('XAUTHORITY', None)
            else:
                os.environ['XAUTHORITY'] = old
        def capture_frames():
            try:
                root = connection.screen().root
                geometry = root.get_geometry()
                previous = None
                while not self.capture_stop.is_set():
                    self.request_frame.wait()
                    self.request_frame.clear()
                    if self.capture_stop.is_set():
                        break
                    try:
                        image = root.get_image(0, 0, geometry.width, geometry.height, X.ZPixmap, 0xffffffff)
                        raw = image.data
                        if geometry.depth in (24, 32) and len(raw) == geometry.width*geometry.height*4 and raw != previous:
                            # X11 BGRX maps directly to little-endian Qt RGB32.
                            # Keep an unchanged texture resident on the GPU.
                            self.latest = QtGui.QImage(raw, geometry.width, geometry.height, geometry.width*4,
                                                       QtGui.QImage.Format_RGB32).copy()
                            previous = raw
                    except Exception:
                        pass
            finally:
                connection.close()
        self.capture_worker = threading.Thread(target=capture_frames, daemon=True, name='NewMate capture')
        self.capture_worker.start()
        self.request_frame.set()
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
        self.resize(QtWidgets.QApplication.primaryScreen().geometry().size())
        self.grabFramebuffer()

    def toggle(self):
        self.goal = 0.0 if self.goal else 1.0
        self.clock = time.monotonic()
        self.origin = self.progress
        if self.goal:
            screen = QtWidgets.QApplication.screenAt(self.host.pet.geometry().center())
            self.setGeometry((screen or QtWidgets.QApplication.primaryScreen()).geometry())
            # Allocate/compile the GL surface before starting the motion clock.
            if not self.isValid():
                self.grabFramebuffer()
            self.clock = time.monotonic()
            self.show()
            self.tick()
            self.host.pet.raise_()

    def tick(self):
        if not self.isVisible():
            return
        t = min(1., (time.monotonic() - self.clock) / .32)
        self.progress = self.origin + (self.goal - self.origin) * (t * t * (3 - 2 * t))
        if t >= 1 and not self.goal:
            self.hide()
        if self.latest is not None:
            self.frame = QtGui.QPixmap.fromImage(self.latest)
            self.latest = None
        self.request_frame.set()
        self.update()

    def stop(self):
        super().stop()
        self.capture_stop.set()
        self.request_frame.set()
        self.capture_worker.join(timeout=3)

    def paintGL(self):
        p = QtGui.QPainter(self)
        p.setRenderHint(QtGui.QPainter.SmoothPixmapTransform)
        pet = self.host.pet.geometry()
        center = self.mapFromGlobal(pet.center())
        start = QtCore.QRectF(center.x(), center.y(), 1, 1)
        end = QtCore.QRectF(self.rect())
        v = self.progress
        rect = QtCore.QRectF(start.x() * (1-v), start.y() * (1-v), end.width()*v, end.height()*v)
        p.fillRect(rect, QtCore.Qt.black)
        if not self.frame.isNull():
            p.drawPixmap(rect, self.frame, QtCore.QRectF(self.frame.rect()))

    # Preview consumes user input. It never forwards a user event to the isolated server.
    def mousePressEvent(self, event):
        event.accept()


class Pet(DisplaySurface):
    def __init__(self, host):
        super().__init__(None, QtCore.Qt.FramelessWindowHint | QtCore.Qt.Tool |
                         QtCore.Qt.WindowStaysOnTopHint | QtCore.Qt.WindowDoesNotAcceptFocus)
        self.host = host
        self.setWindowTitle('NewMate')
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
        self.setAttribute(QtCore.Qt.WA_ShowWithoutActivating)
        self.bitmap = QtGui.QPixmap(str(Path(__file__).parent.parent / 'assets/desktop-pet.png'))
        # Crop transparent margins while preserving the supplied mascot's exact pixels.
        image = self.bitmap.toImage()
        mask = self.bitmap.mask()
        if not mask.isNull():
            rect = QtGui.QRegion(mask).boundingRect()
            if not rect.isEmpty():
                self.bitmap = self.bitmap.copy(rect)
        self.phase = 0.
        self.born = time.monotonic()
        self.preference = self.host.preference_root / 'computer-use/desktop-pet.json'
        self.last_preference = None
        self.multiplier = 1.
        self.sync_size()
        screen = QtWidgets.QApplication.primaryScreen().availableGeometry()
        self.move(screen.right()-self.width()-24, screen.bottom()-self.height()-24)
        self.preference_polled = 0.
        self.press = None

    def sync_size(self):
        try:
            stamp = self.preference.stat().st_mtime_ns
            if stamp == self.last_preference:
                return
            saved = json.loads(self.preference.read_text())
            value = float(saved.get('size_multiplier', 1))
            if saved.get('version') != 2:
                value /= .75
            self.multiplier = max(.3, min(3., value))
            self.last_preference = stamp
        except (OSError, ValueError, TypeError):
            pass
        self.resize(round(180 * self.multiplier)+12, round(144 * self.multiplier)+12)

    def save_size(self, value):
        self.preference.parent.mkdir(parents=True, exist_ok=True)
        try:
            data = json.loads(self.preference.read_text())
        except (OSError, ValueError):
            data = {}
        data['size_multiplier'] = value / 1000.
        data['version'] = 2
        tmp = self.preference.with_suffix('.linux.tmp')
        tmp.write_text(json.dumps(data))
        tmp.replace(self.preference)
        self.sync_size()

    def tick(self):
        now = time.monotonic()
        self.phase = (now * 125) % 360
        if now - self.preference_polled >= .1:
            self.sync_size()
            self.preference_polled = now
        self.update()

    def paintGL(self):
        p = QtGui.QPainter(self)
        p.setRenderHints(QtGui.QPainter.Antialiasing | QtGui.QPainter.SmoothPixmapTransform)
        t = min(1., (time.monotonic()-self.born)/.55)
        scale = 1 - math.exp(-7*t)*math.cos(10*t) if t < 1 else 1.
        p.translate(self.width()/2, self.height()/2)
        p.scale(scale, scale)
        rect = QtCore.QRectF(-self.width()/2+6, -self.height()/2+6, self.width()-12, self.height()-12)
        if not self.host.preview or not self.host.preview.goal:
            # Dilated alpha silhouette: gradient follows the body, not the rectangular window.
            layer = QtGui.QPixmap(self.size())
            layer.fill(QtCore.Qt.transparent)
            lp = QtGui.QPainter(layer)
            grad = QtGui.QConicalGradient(self.width()/2, self.height()/2, self.phase)
            for at, color in [(0, 'black'), (.25, 'white'), (.5, 'black'), (.75, 'white'), (1, 'black')]:
                grad.setColorAt(at, QtGui.QColor(color))
            for dx, dy in [(3, 0), (-3, 0), (0, 3), (0, -3), (2, 2), (-2, -2)]:
                lp.drawPixmap(QtCore.QRectF(6+dx, 6+dy, rect.width(), rect.height()), self.bitmap, QtCore.QRectF(self.bitmap.rect()))
            lp.setCompositionMode(QtGui.QPainter.CompositionMode_SourceIn)
            lp.fillRect(layer.rect(), grad)
            lp.end()
            p.drawPixmap(-self.width()//2, -self.height()//2, layer)
        p.drawPixmap(rect, self.bitmap, QtCore.QRectF(self.bitmap.rect()))

    def mousePressEvent(self, event):
        if event.button() == QtCore.Qt.RightButton:
            menu = QtWidgets.QMenu(self)
            label = QtWidgets.QLabel('NewMate  %.1f%%' % (100*self.multiplier))
            slider = QtWidgets.QSlider(QtCore.Qt.Horizontal)
            slider.setRange(300, 3000)
            slider.setValue(round(self.multiplier*1000))
            slider.valueChanged.connect(self.save_size)
            slider.valueChanged.connect(lambda v: label.setText('NewMate  %.1f%%' % (v/10)))
            content = QtWidgets.QWidget()
            layout = QtWidgets.QVBoxLayout(content)
            layout.addWidget(label); layout.addWidget(slider)
            content.setMinimumWidth(240)
            action = QtWidgets.QWidgetAction(menu); action.setDefaultWidget(content); menu.addAction(action)
            menu.exec_(event.globalPos())
        else:
            self.press = event.globalPos()
            self.start_pos = self.pos()
            self.dragged = False
            self.born = time.monotonic() - .12

    def mouseMoveEvent(self, event):
        if self.press is not None:
            delta = event.globalPos()-self.press
            if delta.manhattanLength() > 5:
                self.dragged = True
                self.move(self.start_pos+delta)

    def mouseReleaseEvent(self, event):
        if self.press is not None and not self.dragged:
            self.host.preview.toggle()
        self.press = None


class Host:
    def __init__(self):
        self.real = display.Display(os.environ['DISPLAY'])
        self.virtual = None
        self.xvfb = None
        self.wm = None
        self.virtual_env = None
        self.pet = None
        self.preview = None
        self.leases = {}
        self.transfers = {}
        self.observations = {}
        self.capture_paths = []
        self.children = []
        self.preference_root = Path.home() / '.Newmark'
        self.root = Path('/tmp/newmark2dsh-cu-%d' % os.getuid())
        self.root.mkdir(mode=0o700, exist_ok=True)
        info = self.root.lstat()
        if self.root.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError('Unsafe runtime directory')
        self.temp = None
        self.orphan = False
        self.buffer = b''
        self.notifier = QtCore.QSocketNotifier(sys.stdin.fileno(), QtCore.QSocketNotifier.Read)
        self.notifier.activated.connect(self.read)
        self.timer = QtCore.QTimer()
        self.timer.setTimerType(QtCore.Qt.PreciseTimer)
        self.timer.timeout.connect(self.tick)
        self.timer.start(max(1, round(1000/QtWidgets.QApplication.primaryScreen().refreshRate())))

    def lock(self, mode, owner):
        if mode in self.leases:
            if self.leases[mode]['owner_id'] != owner:
                raise Refusal('takeover_lease_occupied', 'This mode belongs to another DSH session')
            return False
        fd = os.open(self.root / (mode+'.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise Refusal('takeover_lease_occupied', 'Another DSH host holds the '+mode+' slot')
        self.leases[mode] = {'fd': fd, 'owner_id': owner, 'mouse_mode': mode, 'acquired_at': int(time.time()*1000)}
        return True

    def unlock(self, mode):
        lease = self.leases.pop(mode, None)
        if lease:
            os.close(lease['fd'])

    def start_virtual(self):
        if self.virtual:
            return
        self.temp = tempfile.TemporaryDirectory(prefix='desktop-', dir=self.root)
        auth = str(Path(self.temp.name) / 'Xauthority')
        cookie = secrets.token_hex(16)
        number_hint = str(100 + secrets.randbelow(30000))
        # Xauthority family wild permits displayfd allocation without guessing a free display.
        import struct
        def field(b):
            return struct.pack('!H', len(b)) + b
        with open(auth, 'wb') as f:
            f.write(struct.pack('!H', 256)+field(socket.gethostname().encode())+field(number_hint.encode())+field(b'MIT-MAGIC-COOKIE-1')+field(bytes.fromhex(cookie)))
        os.chmod(auth, 0o600)
        readfd, writefd = os.pipe()
        # WSLg owns a read-only /tmp/.X11-unix mount. Use Linux abstract sockets and a
        # high display number; :0 would alias WSLg's filesystem socket for Xlib clients.
        self.xvfb = subprocess.Popen([sys.executable, str(Path(__file__).with_name('linux-process-guard.py')),
                                     str(writefd), 'Xvfb', ':'+number_hint, '-displayfd', str(writefd), '-screen', '0', '1280x720x24',
                                     '-nolisten', 'tcp', '-nolisten', 'unix', '-auth', auth, '-noreset'], pass_fds=[writefd],
                                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=sys.stderr)
        os.close(writefd)
        import select
        if not select.select([readfd], [], [], 10)[0]:
            os.close(readfd)
            raise Refusal('virtual_start_failed', 'Xvfb did not become ready')
        number = os.read(readfd, 32).decode().strip(); os.close(readfd)
        if not number.isdigit():
            raise Refusal('virtual_start_failed', 'Xvfb failed to allocate a display')
        self.virtual_env = {**os.environ, 'DISPLAY': ':'+number, 'XAUTHORITY': auth,
                            'QT_QPA_PLATFORM': 'xcb', 'GDK_BACKEND': 'x11', 'SDL_VIDEODRIVER': 'x11',
                            'CLUTTER_BACKEND': 'x11', 'MOZ_ENABLE_WAYLAND': '0', 'XDG_SESSION_TYPE': 'x11'}
        self.virtual_env.pop('WAYLAND_DISPLAY', None)
        # python-xlib reads XAUTHORITY during construction; restore immediately, no input thread.
        old = os.environ.get('XAUTHORITY')
        os.environ['XAUTHORITY'] = auth
        try:
            self.virtual = display.Display(':'+number)
        finally:
            if old is None:
                os.environ.pop('XAUTHORITY', None)
            else:
                os.environ['XAUTHORITY'] = old
        root = self.virtual.screen().root
        root.change_attributes(background_pixel=0)
        root.clear_area()
        self.virtual.sync()
        self.wm = subprocess.Popen(['openbox', '--sm-disable'], env=self.virtual_env,
                                   stdout=subprocess.DEVNULL, stderr=sys.stderr)
        # Starting a client while Openbox is still scanning the initially empty tree
        # can race its startup reparent pass. Wait for its EWMH readiness announcement.
        deadline = time.monotonic()+5
        while True:
            ready = root.get_full_property(self.virtual.intern_atom('_NET_SUPPORTING_WM_CHECK'), X.AnyPropertyType)
            if ready and len(ready.value):
                manager = self.virtual.create_resource_object('window', int(ready.value[0]))
                confirmation = manager.get_full_property(self.virtual.intern_atom('_NET_SUPPORTING_WM_CHECK'), X.AnyPropertyType)
                if confirmation and int(confirmation.value[0]) == manager.id:
                    break
            if self.wm.poll() is not None or time.monotonic() >= deadline:
                raise Refusal('window_manager_not_ready', 'Openbox did not complete X11 initialization')
            time.sleep(.025)
        if self.pet:
            self.pet.deleteLater()
        if self.preview:
            self.preview.deleteLater()
        self.pet = Pet(self)
        self.preview = Preview(self)
        self.pet.show()

    def windows(self, d):
        root = d.screen().root
        prop = root.get_full_property(d.intern_atom('_NET_CLIENT_LIST'), X.AnyPropertyType)
        wins = [d.create_resource_object('window', int(x)) for x in prop.value] if prop else root.query_tree().children
        # WSLg's rootless XWayland does not always publish a populated EWMH client list.
        seen = {w.id for w in wins}
        def collect(parent, depth):
            if depth > 3:
                return
            for child in parent.query_tree().children:
                try:
                    if child.id not in seen and child.get_full_property(d.intern_atom('_NET_WM_PID'), X.AnyPropertyType):
                        wins.append(child); seen.add(child.id)
                    collect(child, depth+1)
                except Exception:
                    pass
        collect(root, 0)
        items = []
        concealed = {t['source'].id for t in self.transfers.values() if t['source_display'] is d}
        for w in wins:
            try:
                if w.id in concealed or w.get_attributes().map_state != X.IsViewable:
                    continue
                pidprop = w.get_full_property(d.intern_atom('_NET_WM_PID'), X.AnyPropertyType)
                pid = int(pidprop.value[0]) if pidprop else 0
                if pid == os.getpid():
                    continue
                title = w.get_wm_name() or ''
                if not title:
                    continue
                g = w.get_geometry(); point = root.translate_coords(w, 0, 0)
                items.append({'window_handle': str(w.id), 'title': title, 'process_id': pid,
                              'process_start': identity(pid), 'x': point.x, 'y': point.y,
                              'width': g.width, 'height': g.height})
            except Exception:
                continue
        # Own proxies have this host's PID and are explicitly included, unlike NewMate.
        for key, t in self.transfers.items():
            if t['dest_display'] is d:
                g = t['proxy'].get_geometry()
                point = root.translate_coords(t['proxy'], 0, 0)
                items.append({**t['identity'], 'window_handle': str(t['proxy'].id), 'transfer_id': key,
                              'x': point.x, 'y': point.y, 'width': g.width, 'height': g.height})
        return items

    def target(self, d, o):
        handle = option(o, 'window_handle')
        pid = option(o, 'process_id')
        title = option(o, 'app_target', option(o, 'title', option(o, 'app', '')))
        rows = self.windows(d)
        if handle is not None:
            rows = [r for r in rows if int(r['window_handle'], 0) == int(str(handle), 0)]
        elif pid:
            rows = [r for r in rows if r['process_id'] == int(pid)]
        elif title:
            rows = [r for r in rows if str(title).lower() in r['title'].lower()]
        else:
            raise Refusal('app_target_required', 'Select a window_handle or unambiguous process_id')
        if len(rows) != 1:
            raise Refusal('app_target_not_found' if not rows else 'ambiguous_window', 'Expected exactly one live application window')
        return d.create_resource_object('window', int(rows[0]['window_handle'])), rows[0]

    def transfer(self, action, o, owner):
        if not self.virtual or self.leases.get('virtual', {}).get('owner_id') != owner:
            raise Refusal('takeover_required', 'Own the virtual takeover before crossing desktops')
        reserved = self.lock('real', owner)
        source = parking = saved = proxy = gc = None
        parked = False
        try:
            source_d = self.virtual if action == 'process_push' else self.real
            dest_d = self.real if action == 'process_push' else self.virtual
            key = option(o, 'transfer_id')
            if key:
                t = self.transfers.get(key)
                if not t or t['dest_display'] is not source_d:
                    raise Refusal('transfer_not_found', 'Transfer is absent or already on the requested desktop')
                result = {**t['identity'], 'window_handle': str(t['source'].id), 'transfer_id': key}
                self.restore(key)
                return {'ok': True, 'restored': True, **result}
            source, info = self.target(source_d, o)
            for existing, t in self.transfers.items():
                if t['proxy'].id == source.id and t['dest_display'] is source_d:
                    return self.transfer(action, {**o, 'transfer_id': existing}, owner)
            if not source_d.has_extension('Composite'):
                raise Refusal('composite_required', 'XComposite is required for live window mapping')
            root = source_d.screen().root
            source.change_save_set(X.SetModeInsert)
            parked = True
            # Let the WM withdraw its decoration before parking. Otherwise its queued
            # UnmapNotify handler can unmap the just-redirected client behind our back.
            source.unmap()
            source_d.sync()
            time.sleep(.08)
            source.change_attributes(override_redirect=1)
            parking = root.create_window(-16000, -16000, info['width'], info['height'], 0,
                                         X.CopyFromParent, X.InputOutput, X.CopyFromParent, override_redirect=1)
            parking.map()
            source.reparent(parking, 0, 0)
            source.map()
            for attempt in range(8):
                source_d.sync()
                time.sleep(.08)
                if source.query_tree().parent.id == parking.id and source.get_attributes().map_state == X.IsViewable:
                    break
                source.reparent(parking, 0, 0)
                source.map()
            source.composite_redirect_window(composite.RedirectManual)
            source_d.sync()
            time.sleep(.04)
            saved = source.composite_name_window_pixmap()
            # Force a round trip before reporting success. BadMatch is asynchronous on
            # NameWindowPixmap; a valid image is the actual readiness test.
            capture(source_d, saved)
            destroot = dest_d.screen().root
            proxy = destroot.create_window(100, 100, info['width'], info['height'], 0,
                                          X.CopyFromParent, X.InputOutput, X.CopyFromParent,
                                          background_pixel=0, event_mask=X.ExposureMask | X.ButtonPressMask |
                                          X.ButtonReleaseMask | X.PointerMotionMask | X.KeyPressMask | X.KeyReleaseMask | X.StructureNotifyMask)
            proxy.set_wm_name((info['title']+' - NewMate').encode('latin-1', 'replace'))
            proxy.change_property(dest_d.intern_atom('_NET_WM_NAME'), dest_d.intern_atom('UTF8_STRING'),
                                  8, (info['title']+' — NewMate').encode('utf-8'))
            proxy.change_property(dest_d.intern_atom('_NET_WM_PID'), Xatom_CARDINAL, 32, [os.getpid()])
            proxy.set_wm_protocols([dest_d.intern_atom('WM_DELETE_WINDOW')])
            gc = proxy.create_gc()
            proxy.map(); dest_d.sync()
            key = uuid.uuid4().hex
            self.transfers[key] = {'source': source, 'source_display': source_d, 'dest_display': dest_d,
                                   'proxy': proxy, 'parking': parking, 'pixmap': saved, 'gc': gc,
                                   'identity': info, 'direction': action}
            self.pet.born = time.monotonic()-.1
            return {'ok': True, 'transfer_id': key, 'source_window_handle': str(source.id),
                    'window_handle': str(proxy.id), 'process_id': info['process_id'],
                    'process_start': info['process_start'], 'delivery': 'x11-presentation-mapping',
                    'input_compatibility': 'XSendEvent-compatible applications only',
                    'native_window_moved_between_servers': False}
        except Exception:
            if parked:
                safe_to_destroy = False
                try:
                    source.composite_unredirect_window(composite.RedirectManual)
                    source.unmap()
                    source.change_attributes(override_redirect=0)
                    source.reparent(root, max(0, info['x']), max(0, info['y']))
                    source.map()
                    source_d.sync()
                    safe_to_destroy = not parking or source.query_tree().parent.id != parking.id
                    if safe_to_destroy:
                        source.change_save_set(X.SetModeDelete)
                finally:
                    for resource, method in [(proxy,'destroy'), (parking,'destroy'), (saved,'free'), (gc,'free')]:
                        if resource is parking and not safe_to_destroy:
                            continue  # Keep the SaveSet container until connection teardown.
                        if resource:
                            try:
                                getattr(resource, method)()
                            except Exception:
                                pass
            raise
        finally:
            if reserved:
                self.unlock('real')

    def restore(self, key):
        t = self.transfers[key]
        safe_to_destroy = False
        try:
            info = t['identity']
            source = t['source']; d = t['source_display']
            try:
                source.get_geometry()
            except (xerror.BadWindow, xerror.BadDrawable):
                safe_to_destroy = True
                return
            source.composite_unredirect_window(composite.RedirectManual)
            source.unmap()
            source.change_attributes(override_redirect=0)
            source.reparent(d.screen().root, max(0, info['x']), max(0, info['y']))
            source.map(); d.sync()
            if source.query_tree().parent.id == t['parking'].id:
                raise Refusal('restore_incomplete', 'Original window remains parked; SaveSet protection retained')
            safe_to_destroy = True
            source.change_save_set(X.SetModeDelete)
        finally:
            if safe_to_destroy:
                self.transfers.pop(key, None)
                t['proxy'].destroy(); t['parking'].destroy(); t['pixmap'].free(); t['gc'].free()
                t['dest_display'].flush(); t['source_display'].flush()

    def forward(self, t, e):
        d = t['source_display']; w = t['source']
        event_cls = {X.ButtonPress: protocol.event.ButtonPress, X.ButtonRelease: protocol.event.ButtonRelease,
                     X.MotionNotify: protocol.event.MotionNotify,
                     X.KeyPress: protocol.event.KeyPress, X.KeyRelease: protocol.event.KeyRelease}.get(e.type)
        if event_cls:
            detail = e.detail
            if e.type in (X.KeyPress, X.KeyRelease):
                sym = t['dest_display'].keycode_to_keysym(detail, 0)
                detail = d.keysym_to_keycode(sym)
            event = event_cls(time=X.CurrentTime, root=d.screen().root, window=w, child=X.NONE,
                              root_x=0, root_y=0, event_x=e.event_x, event_y=e.event_y,
                              state=e.state, detail=detail, same_screen=1)
            w.send_event(event, propagate=True)
            d.flush()

    def tick(self):
        screen = QtWidgets.QApplication.primaryScreen()
        if self.pet and self.pet.windowHandle():
            screen = self.pet.windowHandle().screen()
        interval = max(1, round(1000/max(1., screen.refreshRate())))
        if interval != self.timer.interval():
            self.timer.setInterval(interval)
        for child in self.children:
            child.poll()
        for key, t in list(self.transfers.items()):
            try:
                if t['identity']['process_id'] and identity(t['identity']['process_id']) != t['identity']['process_start']:
                    self.restore(key); continue
                src = t['source']; g = src.get_geometry()
                image = capture(t['source_display'], t['pixmap'])
                dest = t['proxy']; target = dest.get_geometry()
                if image.size != (target.width, target.height):
                    image = image.resize((target.width, target.height))
                raw = image.tobytes('raw', 'BGRX')
                # X requests have a maximum length: upload strips, never one oversized frame.
                stride = image.width*4
                rows = max(1, 60000//stride)
                for y in range(0, image.height, rows):
                    h = min(rows, image.height-y)
                    dest.put_image(t['gc'], 0, y, image.width, h, X.ZPixmap, 24, 0, raw[y*stride:(y+h)*stride])
                t['dest_display'].flush()
            except Exception as e:
                print('transfer frame: '+str(e), file=sys.stderr)
                try:
                    self.restore(key)
                except Exception:
                    pass
        for d in (self.real, self.virtual):
            if not d:
                continue
            while d.pending_events():
                e = d.next_event()
                for key, t in list(self.transfers.items()):
                    if t['dest_display'] is d and getattr(e, 'window', None) == t['proxy']:
                        if e.type == X.ClientMessage:
                            source = t['source']; sd = t['source_display']
                            source.send_event(protocol.event.ClientMessage(window=source,
                                client_type=sd.intern_atom('WM_PROTOCOLS'),
                                data=(32, [sd.intern_atom('WM_DELETE_WINDOW'), X.CurrentTime, 0, 0, 0])))
                            sd.flush()
                        else:
                            self.forward(t, e)
        if not self.leases.get('virtual') and not self.transfers and self.virtual:
            self.stop_virtual()
        if self.orphan and not self.transfers:
            self.cleanup()
            QtWidgets.QApplication.quit()

    def stop_virtual(self):
        for key, t in list(self.transfers.items()):
            if t['direction'] == 'process_pull':
                self.restore(key)
        if self.preview:
            self.preview.hide()
            self.preview.timer.stop()
        if self.pet:
            self.pet.hide()
            self.pet.timer.stop()
        retained = bool(self.transfers)
        exported_groups = set()
        for t in self.transfers.values():
            try:
                exported_groups.add(os.getpgid(t['identity']['process_id']))
            except OSError:
                pass
        kept = []
        for proc in self.children:
            if proc.pid in exported_groups:
                kept.append(proc)
            elif proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                    proc.wait(timeout=2)
                except ProcessLookupError:
                    pass
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
        self.children = kept
        if not retained:
            if self.wm:
                self.wm.terminate(); self.wm.wait(timeout=3); self.wm = None
            if self.virtual:
                self.virtual.close(); self.virtual = None
            if self.xvfb:
                self.xvfb.terminate(); self.xvfb.wait(timeout=3); self.xvfb = None
            if self.temp:
                self.temp.cleanup(); self.temp = None
        return retained

    def cleanup(self):
        for key in list(self.transfers):
            try:
                self.restore(key)
            except Exception:
                pass
        self.stop_virtual()
        for mode in list(self.leases):
            self.unlock(mode)

    def dispatch(self, o):
        action = str(o.get('action', 'observe'))
        if option(o, 'dry_run', False):
            return {'ok': True, 'dry_run': True, 'action_executed': False}
        owner = str(option(o, 'owner_id', 'direct'))
        requested = option(o, 'mouse_mode')
        owned = [m for m, lease in self.leases.items() if lease['owner_id'] == owner]
        if requested is None and len(owned) > 1 and action != 'mode_report':
            raise Refusal('mouse_mode_required', 'Specify mouse_mode when holding both slots')
        mode = requested or (owned[0] if len(owned) == 1 else 'real')
        if mode not in ('real', 'virtual'):
            raise Refusal('invalid_mouse_mode', 'Expected real or virtual')
        if action == 'takeover_start':
            if o.get('launch') and mode != 'virtual':
                raise Refusal('launch_requires_virtual', 'launch is accepted on virtual takeover_start only')
            if mode == 'virtual' and 'virtual' not in self.leases and self.transfers:
                raise Refusal('retained_exports_active', 'Close exported applications before starting a new virtual session in this host')
            fresh = self.lock(mode, owner)
            try:
                if mode == 'virtual':
                    self.preference_root = Path(option(o, 'user_root', str(Path.home() / '.Newmark')))
                    self.start_virtual()
                    if o.get('launch'):
                        proc = subprocess.Popen(shlex.split(o['launch']), env=self.virtual_env,
                                                start_new_session=True, stdout=subprocess.DEVNULL, stderr=sys.stderr)
                        self.children.append(proc)
                return {'ok': True, 'lease': {k:v for k,v in self.leases[mode].items() if k != 'fd'},
                        'hidden_desktop': {'display': self.virtual_env['DISPLAY'] if self.virtual_env else None,
                            'launched': [{'pid': p.pid, 'process_start': identity(p.pid)} for p in self.children]},
                        'virtual_mode_supported': True, 'mouse_mode': mode}
            except Exception:
                if fresh:
                    if mode == 'virtual':
                        self.stop_virtual()
                    self.unlock(mode)
                raise
        if action == 'mode_report':
            return {'ok': True, 'backend': 'linux-x11-isolated', 'virtual_mode_supported': True,
                    'host_pid': os.getpid(),
                    'native_wayland_supported': False, 'real_display': os.environ['DISPLAY'],
                    'capabilities': {'input': 'X11/XTEST', 'transfer': 'XComposite/XSendEvent',
                        'menu_renderer': 'qt-native-slider', 'dsh_css_menu': False,
                        'transfer_flight_animation': False, 'cross_os_takeover_lock': False,
                        'wslg_real_scope': 'Linux X11 surfaces, not the Windows desktop'},
                    'virtual_display': self.virtual_env['DISPLAY'] if self.virtual else None,
                    'slots': {m:{k:v for k,v in l.items() if k != 'fd'} for m,l in self.leases.items()},
                    'desktop_transfers': [{'transfer_id': k, **t['identity'], 'direction': t['direction'],
                        'window_handle': str(t['proxy'].id)} for k,t in self.transfers.items()],
                    'preview_expanded': bool(self.preview and self.preview.goal),
                    'newmate_size_multiplier': self.pet.multiplier if self.pet else None}
        if action in ('process_push', 'process_pull'):
            return self.transfer(action, o, owner)
        readonly = action in ('app_list', 'observe', 'app_observe', 'capture_screen', 'wait', 'wait_for')
        if not readonly or mode == 'virtual':
            if self.leases.get(mode, {}).get('owner_id') != owner:
                raise Refusal('takeover_required', 'This DSH session must own the requested mode')
        if action == 'takeover_stop':
            retained = self.stop_virtual() if mode == 'virtual' else False
            self.unlock(mode)
            return {'ok': True, 'released_owner': owner, 'retained_exported_applications': retained}
        if mode == 'real':
            return {'ok': True, 'legacy_real_dispatch': True}
        d = self.virtual if mode == 'virtual' else self.real
        if not d:
            raise Refusal('takeover_required', 'Virtual desktop has not started')
        if action == 'app_list':
            return {'ok': True, 'applications': self.windows(d)}
        if action == 'wait_for':
            started = time.monotonic()
            timeout = max(1, min(60000, int(option(o, 'timeout_ms', 5000))))
            handle = option(o, 'window_handle')
            text = str(o.get('text', '')).lower()
            while True:
                rows = self.windows(d)
                matches = [r for r in rows if (not handle or int(r['window_handle']) == int(str(handle), 0))
                           and (not text or text in r['title'].lower())]
                elapsed = int((time.monotonic()-started)*1000)
                if matches or elapsed >= timeout:
                    target_state = None
                    if handle and not matches:
                        try:
                            probe = d.create_resource_object('window', int(str(handle), 0))
                            target_state = {'map_state': probe.get_attributes().map_state,
                                            'title': probe.get_wm_name(), 'parent': probe.query_tree().parent.id}
                        except Exception as e:
                            target_state = {'error': str(e)}
                    return {'ok': True, 'matched': bool(matches), 'reason': 'match' if matches else 'timeout',
                            'matched_window': matches[0] if matches else None, 'elapsed_ms': elapsed,
                            'applications': rows, 'target_state': target_state,
                            'window_manager_exit_code': self.wm.poll() if self.wm else None,
                            'launched_processes': [{'pid':p.pid,'exit_code':p.poll()} for p in self.children],
                            'text_match_scope': 'X11 window titles only; no accessibility text tree'}
                loop = QtCore.QEventLoop(); QtCore.QTimer.singleShot(100, loop.quit); loop.exec_()
        if action in ('observe', 'capture_screen', 'app_observe'):
            w, info = self.target(d, o) if action == 'app_observe' else (d.screen().root, None)
            cache_key = (owner, mode, w.id)
            sparse = option(o, 'observation') == 'sparse' or option(o, 'sparse')
            baseline = self.observations.get(cache_key)
            deadline = time.monotonic() + max(0, min(5000, int(option(o, 'sparse_wait_ms', 0))))/1000
            while True:
                img = capture(d, w)
                digest = hashlib.sha256(img.resize((64,36)).convert('L').tobytes()).hexdigest()
                if not sparse or digest != baseline or time.monotonic() >= deadline:
                    break
                loop = QtCore.QEventLoop(); QtCore.QTimer.singleShot(200, loop.quit); loop.exec_()
            if sparse:
                return {'ok': True, 'observation': 'sparse', 'changed': digest != baseline,
                        'must_reacquire_full_observation': digest != baseline, 'baseline_present': baseline is not None}
            self.observations[cache_key] = digest
            maxw = max(1, int(option(o, 'capture_max_width', img.width)))
            maxh = max(1, int(option(o, 'capture_max_height', img.height)))
            img.thumbnail((maxw, maxh))
            output = self.root / ('capture-'+uuid.uuid4().hex+'.png')
            img.save(output)
            self.capture_paths.append(output)
            while len(self.capture_paths) > 64:
                self.capture_paths.pop(0).unlink(missing_ok=True)
            return {'ok': True, 'image_path': str(output), 'width': img.width, 'height': img.height,
                    'app': info, 'applications': self.windows(d)}
        if action == 'wait':
            delay = max(0, min(60000, float(option(o, 'duration_ms', 1000))))
            loop = QtCore.QEventLoop(); QtCore.QTimer.singleShot(int(delay), loop.quit); loop.exec_()
            return {'ok': True, 'duration_ms': delay}
        if action == 'sequence':
            steps = o.get('steps', [])
            if len(steps) > 100:
                raise Refusal('sequence_too_long', 'At most 100 steps')
            results = []
            for step in steps:
                if step.get('action') not in ('move','click','drag','scroll','type','key','wait'):
                    raise Refusal('invalid_sequence_action', 'Only input and wait steps are allowed')
                results.append(self.dispatch({**o, **step, 'owner_id': owner, 'mouse_mode': mode}))
            return {'ok': True, 'steps': results}
        env = self.virtual_env if mode == 'virtual' else os.environ
        base = action.removeprefix('app_')
        w = None
        info = None
        if action.startswith('app_'):
            w, info = self.target(d, o)
        if base == 'activate':
            run(['xdotool', 'windowactivate', '--sync', str(w.id)], env)
        elif base in ('move', 'click', 'drag', 'scroll'):
            x = int(option(o, 'start_x', o.get('x', 0)) if base == 'drag' else o.get('x', 0))
            y = int(option(o, 'start_y', o.get('y', 0)) if base == 'drag' else o.get('y', 0))
            if w:
                if not (0 <= x < info['width'] and 0 <= y < info['height']):
                    raise Refusal('coordinates_outside_window', 'Use client-local coordinates')
                x += info['x']; y += info['y']
            if not (0 <= x < d.screen().width_in_pixels and 0 <= y < d.screen().height_in_pixels):
                raise Refusal('coordinates_outside_desktop', 'Coordinates outside selected display')
            run(['xdotool', 'mousemove', '--sync', str(x), str(y)], env)
            button = str({'left':1, 'middle':2, 'right':3}.get(o.get('button'), 1))
            if base == 'click':
                run(['xdotool', 'click', button], env)
            if base == 'scroll':
                for name, pos, neg in [('scroll_y',4,5), ('scroll_x',7,6)]:
                    delta = int(option(o, name, 0))
                    if delta:
                        run(['xdotool', 'click', '--repeat', str(min(100, abs(delta))), str(pos if delta>0 else neg)], env)
            if base == 'drag':
                endx, endy = int(option(o, 'end_x', 0)), int(option(o, 'end_y', 0))
                if w:
                    if not (0 <= endx < info['width'] and 0 <= endy < info['height']):
                        raise Refusal('coordinates_outside_window', 'Drag end is outside the client')
                    endx += info['x']; endy += info['y']
                if not (0 <= endx < d.screen().width_in_pixels and 0 <= endy < d.screen().height_in_pixels):
                    raise Refusal('coordinates_outside_desktop', 'Drag end is outside the selected display')
                run(['xdotool', 'mousedown', button, 'mousemove', str(endx), str(endy), 'mouseup', button], env)
        elif base in ('type', 'key'):
            args = ['xdotool', 'type' if base == 'type' else 'key']
            if w:
                args += ['--window', str(w.id)]
            value = str(o.get('text' if base == 'type' else 'key', ''))
            if base == 'key':
                names = {'enter':'Return','escape':'Escape','esc':'Escape','backspace':'BackSpace',
                         'delete':'Delete','tab':'Tab','space':'space','left':'Left','right':'Right','up':'Up','down':'Down'}
                value = '+'.join(names.get(k.lower(), k) for k in value.split('+'))
            args += ['--', value]
            run(args, env)
        else:
            raise Refusal('unsupported_action', 'Not implemented by the isolated X11 backend: '+action)
        return {'ok': True, 'mouse_mode': mode, 'delivery': 'x11-xtest' if not w else 'x11-targeted',
                'physical_delivery_used': mode == 'real', 'system_cursor_moved': mode == 'real' and base in ('move','click','scroll','drag'),
                'app': info}

    def read(self):
        data = os.read(sys.stdin.fileno(), 65536)
        if not data:
            self.notifier.setEnabled(False)
            self.stop_virtual()
            for mode in list(self.leases):
                self.unlock(mode)
            self.orphan = True
            return
        self.buffer += data
        if len(self.buffer) > 1024*1024:
            raise RuntimeError('Native request exceeds 1 MiB')
        while b'\n' in self.buffer:
            line, self.buffer = self.buffer.split(b'\n', 1)
            request = json.loads(line)
            self.notifier.setEnabled(False)
            try:
                result = self.dispatch(request['options'])
            except Exception as e:
                result = {'ok': False, 'error_code': getattr(e, 'code', 'linux_desktop_error'), 'error': str(e)}
            finally:
                self.notifier.setEnabled(True)
            result.setdefault('physical_delivery_used', False)
            result.setdefault('system_cursor_moved', False)
            result['fallback_to_real_delivery'] = False
            result['action'] = request['options'].get('action', 'observe')
            print(json.dumps({'id': request['id'], 'result': result}), flush=True)


Xatom_CARDINAL = 6
if __name__ == '__main__':
    app = QtWidgets.QApplication([])
    app.setQuitOnLastWindowClosed(False)
    host = Host()
    atexit.register(host.cleanup)
    signal.signal(signal.SIGTERM, lambda *_: app.quit())
    signal.signal(signal.SIGINT, lambda *_: app.quit())
    app.exec_()
