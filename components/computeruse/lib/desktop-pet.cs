// Native virtual-mode indicator and read-only viewer. .NET Framework, C# 5.
// No input injection, desktop switching, or code executed on the source desktop.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class PetNative {
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; public Point(int x, int y) { X=x; Y=y; } }
    [StructLayout(LayoutKind.Sequential)] internal struct Size { public int X, Y; public Size(int x, int y) { X=x; Y=y; } }
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, Pack=1)] internal struct Blend { public byte Operation, Flags, Alpha, Format; }
    [StructLayout(LayoutKind.Sequential)] internal struct BitmapInfo {public uint Size;public int Width,Height;public ushort Planes,Bits;public uint Compression,ImageSize;public int XPels,YPels;public uint Used,Important;}
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateDIBSection(IntPtr dc,ref BitmapInfo info,uint usage,out IntPtr bits,IntPtr section,uint offset);
    [DllImport("winmm.dll")] internal static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")] internal static extern uint timeEndPeriod(uint period);
    internal delegate bool EnumWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] internal static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] internal static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr w, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] internal static extern IntPtr GetDC(IntPtr w);
    [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr w, IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool UpdateLayeredWindow(IntPtr w, IntPtr dest, ref Point p, ref Size size, IntPtr source, ref Point origin, int key, ref Blend blend, int flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] internal static extern IntPtr OpenDesktop(string name, int flags, bool inherit, uint access);
    [DllImport("user32.dll")] internal static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",SetLastError=true)] internal static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindow callback, IntPtr data);
    [DllImport("kernel32.dll")] internal static extern void SetLastError(uint error);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr w);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr w);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr w, out Rect r);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
    [DllImport("user32.dll")] internal static extern bool PrintWindow(IntPtr w, IntPtr dc, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] internal static extern int GetClassName(IntPtr w, StringBuilder text, int max);
    [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindow callback, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] internal static extern bool SetProp(IntPtr w, string name, IntPtr value);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] internal static extern IntPtr GetProp(IntPtr w, string name);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] internal static extern IntPtr RemoveProp(IntPtr w, string name);
    private const string ViewerProperty="Newmark.ComputerUse.ReadOnlyViewer";
    private const string PetProperty="Newmark.ComputerUse.DesktopPet";
    internal static void MarkViewer(IntPtr w) { SetProp(w,ViewerProperty,new IntPtr(1)); }
    internal static void UnmarkViewer(IntPtr w) { RemoveProp(w,ViewerProperty); }
    internal static void MarkPet(IntPtr w) { SetProp(w,PetProperty,new IntPtr(1)); }
    internal static void UnmarkPet(IntPtr w) { RemoveProp(w,PetProperty); }
    internal static bool IsIndicator(IntPtr w) { return GetProp(w,ViewerProperty)!=IntPtr.Zero || GetProp(w,PetProperty)!=IntPtr.Zero; }
    internal static bool AnyViewer() {
        bool found=false;
        EnumWindows(delegate(IntPtr w, IntPtr data) {
            if (IsWindowVisible(w) && GetProp(w,ViewerProperty)!=IntPtr.Zero) { found=true; return false; }
            return true;
        },IntPtr.Zero);
        return found;
    }
    internal static void Raise(IntPtr hwnd) { SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x13); }
    internal static object Bounds(Rectangle r) { return new { x=r.X, y=r.Y, width=r.Width, height=r.Height }; }
}

// A single pending UI frame, paced by a monotonic deadline instead of WM_TIMER quantization.
internal sealed class PetFrameClock : IDisposable {
    private readonly Control owner;private readonly Action frame;private readonly Stopwatch clock=Stopwatch.StartNew();
    private System.Threading.Timer timer;private int pending;private double deadline;private volatile bool stopped=true;private bool resolution;
    internal PetFrameClock(Control owner,Action frame){this.owner=owner;this.frame=frame;}
    internal void Start(){if(!stopped)return;stopped=false;deadline=clock.Elapsed.TotalMilliseconds;resolution=PetNative.timeBeginPeriod(1)==0;timer=new System.Threading.Timer(Pulse,null,0,4);}
    private void Pulse(object state){if(stopped)return;double now=clock.Elapsed.TotalMilliseconds;if(now<deadline || Interlocked.CompareExchange(ref pending,1,0)!=0)return;
        deadline=Math.Max(deadline+1000.0/60,now);
        try{owner.BeginInvoke(new Action(delegate{try{if(!stopped&&!owner.IsDisposed)frame();}finally{Interlocked.Exchange(ref pending,0);}}));}
        catch(InvalidOperationException){Interlocked.Exchange(ref pending,0);}
    }
    internal void Stop(){if(stopped)return;stopped=true;if(timer!=null){timer.Dispose();timer=null;}if(resolution){PetNative.timeEndPeriod(1);resolution=false;}}
    public void Dispose(){Stop();}
}
// Reuse the memory DC, premultiplied DIB and Graphics until the canvas dimensions change.
internal sealed class PetSurface : IDisposable {
    internal readonly Bitmap Bitmap;internal readonly Graphics Graphics;internal readonly IntPtr DC;
    private IntPtr dib,old;
    internal PetSurface(int width,int height){
        DC=PetNative.CreateCompatibleDC(IntPtr.Zero);var info=new PetNative.BitmapInfo{Size=40,Width=width,Height=-height,Planes=1,Bits=32};IntPtr bits;
        dib=PetNative.CreateDIBSection(DC,ref info,0,out bits,IntPtr.Zero,0);
        if(dib==IntPtr.Zero){PetNative.DeleteDC(DC);throw new InvalidOperationException("Cannot allocate NewMate surface");}
        old=PetNative.SelectObject(DC,dib);Bitmap=new Bitmap(width,height,width*4,PixelFormat.Format32bppPArgb,bits);Graphics=Graphics.FromImage(Bitmap);
        Graphics.InterpolationMode=InterpolationMode.HighQualityBilinear;Graphics.PixelOffsetMode=PixelOffsetMode.HighQuality;
    }
    public void Dispose(){Graphics.Dispose();Bitmap.Dispose();PetNative.SelectObject(DC,old);PetNative.DeleteObject(dib);PetNative.DeleteDC(DC);}
}

internal sealed class PetConfig {
    public int ownerPid { get; set; }
    public string desktop { get; set; }
    public string asset { get; set; }
    public string directory { get; set; }
    public string settingsPath { get; set; }
    public string menuThemePath { get; set; }
    public string menuShellPath { get; set; }
    public string menuCachePath { get; set; }
}

internal static class PetFiles {
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength=12*1024*1024 };
    internal static void Write(string path, string value) {
        string temp = path + ".tmp";
        File.WriteAllText(temp, value);
        if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
    }
    internal static void WriteJson(string path, object value) { Write(path, Json.Serialize(value)); }
    internal static bool Alive(int pid, long identity) {
        try { using (Process p=Process.GetProcessById(pid)) return !p.HasExited && p.StartTime.ToUniversalTime().Ticks == identity; }
        catch { return false; }
    }
    internal static long Identity(int pid) { using (Process p=Process.GetProcessById(pid)) return p.StartTime.ToUniversalTime().Ticks; }
}

// PrintWindow may hang in another application's renderer. Only this disposable
// process ever calls it; a watchdog still runs when the capture thread is stuck.
internal static class DesktopCapture {
    internal static void Run(PetConfig config, int parentPid) {
        long identity=PetFiles.Identity(parentPid);
        using (var watchdog=new System.Threading.Timer(delegate {
            if (!PetFiles.Alive(parentPid,identity)) Environment.Exit(0);
        }, null, 0, 500)) {
            while (PetFiles.Alive(parentPid,identity)) {
                try { Capture(config, parentPid); }
                catch (Exception ex) { PetFiles.WriteJson(Path.Combine(config.directory,"capture-error.json"), new { error=ex.Message }); }
                Thread.Sleep(400);
            }
        }
    }
    private static void Capture(PetConfig config, int parentPid) {
        IntPtr desktop=PetNative.OpenDesktop(config.desktop,0,false,0x41);
        if (desktop==IntPtr.Zero) throw new InvalidOperationException("Cannot open virtual desktop ("+Marshal.GetLastWin32Error()+").");
        try {
            var windows=new List<IntPtr>();
            PetNative.SetLastError(0);
            if (!PetNative.EnumDesktopWindows(desktop, delegate(IntPtr w, IntPtr data) {
                uint pid; PetNative.GetWindowThreadProcessId(w,out pid);
                if (PetNative.IsIndicator(w) || PetNative.GetProp(w,"Newmark2DSH.TransferSource")!=IntPtr.Zero) return true;
                var className=new StringBuilder(256); PetNative.GetClassName(w,className,className.Capacity);
                // Input-method service windows are marked visible even without any
                // painted UI; PrintWindow turns their invisible rectangles black.
                string cls=className.ToString();
                if (cls=="IME" || cls=="MSCTFIME UI") return true;
                if (pid!=parentPid && pid!=Process.GetCurrentProcess().Id && PetNative.IsWindowVisible(w) && !PetNative.IsIconic(w)) windows.Add(w);
                return true;
            }, IntPtr.Zero) && Marshal.GetLastWin32Error()!=0) throw new InvalidOperationException("Cannot enumerate virtual desktop ("+Marshal.GetLastWin32Error()+").");
            Rectangle screen=SystemInformation.VirtualScreen;
            using (var composed=new Bitmap(screen.Width,screen.Height,PixelFormat.Format32bppRgb))
            using (var g=Graphics.FromImage(composed)) {
                g.Clear(Color.Black);
                int captured=0, failed=0;
                // EnumDesktopWindows is top-to-bottom; paint back-to-front.
                windows.Reverse();
                foreach (IntPtr w in windows) {
                    PetNative.Rect r;
                    if (!PetNative.GetWindowRect(w,out r)) continue;
                    int width=r.Right-r.Left, height=r.Bottom-r.Top;
                    if (width<=0 || height<=0 || width>16384 || height>16384 || (long)width*height>64000000) continue;
                    if (!screen.IntersectsWith(new Rectangle(r.Left,r.Top,width,height))) continue;
                    // PrintWindow renders DPI-unaware apps in logical pixels. Capture
                    // in that window's context, then scale to its physical screen rect.
                    IntPtr previousDpi=PetNative.SetThreadDpiAwarenessContext(PetNative.GetWindowDpiAwarenessContext(w));
                    Bitmap bitmap=null;
                    bool ok=false;
                    try {
                        PetNative.Rect logical;
                        if (!PetNative.GetWindowRect(w,out logical)) continue;
                        int lw=logical.Right-logical.Left, lh=logical.Bottom-logical.Top;
                        if (lw<=0 || lh<=0 || lw>16384 || lh>16384 || (long)lw*lh>64000000) continue;
                        bitmap=new Bitmap(lw,lh,PixelFormat.Format32bppRgb);
                        using (var wg=Graphics.FromImage(bitmap)) {
                            IntPtr dc=wg.GetHdc();
                            try { ok=PetNative.PrintWindow(w,dc,2); }
                            finally { wg.ReleaseHdc(dc); }
                        }
                    } finally { PetNative.SetThreadDpiAwarenessContext(previousDpi); }
                    if (bitmap!=null) using (bitmap) {
                        if (ok) { g.DrawImage(bitmap,new Rectangle(r.Left-screen.Left,r.Top-screen.Top,width,height)); captured++; }
                        else failed++;
                    }
                }
                string target=Path.Combine(config.directory,"frame.png"), temp=target+".tmp";
                composed.Save(temp,ImageFormat.Png);
                if (File.Exists(target)) File.Replace(temp,target,null); else File.Move(temp,target);
                PetFiles.WriteJson(Path.Combine(config.directory,"capture.json"),new {
                    captured=captured, failed=failed, desktop=config.desktop, bounds=PetNative.Bounds(screen),
                    utc=DateTime.UtcNow.ToString("o"), method="EnumDesktopWindows/PrintWindow", read_only=true
                });
            }
        } finally { PetNative.CloseDesktop(desktop); }
    }
}

// Time-based springs preserve position and velocity when an interaction reverses.
// Integrate with bounded substeps, independent of WinForms timer jitter.
internal sealed class PetSpring {
    internal double Value, Velocity, Target;
    internal PetSpring(double value) { Value=value; Target=1; }
    internal bool Moving { get { return Math.Abs(Target-Value)>0.001 || Math.Abs(Velocity)>0.01; } }
    internal void Step(double dt, double frequency, double damping) {
        int steps=Math.Max(1,(int)Math.Ceiling(dt/0.008)); double h=dt/steps;
        for (int i=0;i<steps;i++) { Velocity+=(frequency*frequency*(Target-Value)-2*damping*frequency*Velocity)*h; Value+=Velocity*h; }
        if (!Moving) { Value=Target; Velocity=0; }
    }
}

internal sealed class DesktopViewer : Form {
    private readonly PetConfig config;
    private readonly Microsoft.Web.WebView2.WinForms.WebView2 web=new Microsoft.Web.WebView2.WinForms.WebView2();
    private bool closed,busy,dirty;private double progress;private string frameSource="";private Bitmap frame;
    internal bool Ready;internal long PresentedFrames;internal bool HasFrame;
    internal string Message="正在加载虚拟桌面…";
    internal Action Collapse;
    internal Rectangle FullBounds,ContentBounds;
    internal new Point Anchor;
    internal new double Scale;
    internal Bitmap Frame {get{return frame;}set{frame=value;HasFrame=value!=null;if(value!=null){using(var bytes=new MemoryStream()){value.Save(bytes,ImageFormat.Png);frameSource="data:image/png;base64,"+Convert.ToBase64String(bytes.ToArray());}}else frameSource="";Submit();}}
    internal DesktopViewer(PetConfig config) {
        this.config=config;Text="Newmark Virtual Desktop — Read Only";FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;
        StartPosition=FormStartPosition.Manual;AutoScaleMode=AutoScaleMode.None;KeyPreview=true;BackColor=Color.Magenta;TransparencyKey=Color.Magenta;
        web.Dock=DockStyle.Fill;web.DefaultBackgroundColor=Color.Transparent;
        web.CreationProperties=new Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties {UserDataFolder=config.menuCachePath??Path.Combine(config.directory,"viewer-cache")};
        Controls.Add(web);Shown+=delegate{Initialize();};
    }
    protected override CreateParams CreateParams {get{var cp=base.CreateParams;cp.ExStyle|=0x88;return cp;}}
    protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);PetNative.MarkViewer(Handle);}
    protected override void OnHandleDestroyed(EventArgs e){PetNative.UnmarkViewer(Handle);base.OnHandleDestroyed(e);}
    protected override bool ProcessCmdKey(ref Message msg,Keys keys){if(keys==Keys.Escape||keys==(Keys.Alt|Keys.F4))Collapse();return true;}
    private async void Initialize(){
        try{
            await web.EnsureCoreWebView2Async(null);if(closed)return;var core=web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.AreDevToolsEnabled=false;core.Settings.AreBrowserAcceleratorKeysEnabled=false;core.Settings.IsZoomControlEnabled=false;core.Settings.IsStatusBarEnabled=false;
            core.PermissionRequested+=delegate(object sender,Microsoft.Web.WebView2.Core.CoreWebView2PermissionRequestedEventArgs e){e.State=Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Deny;};
            core.NewWindowRequested+=delegate(object sender,Microsoft.Web.WebView2.Core.CoreWebView2NewWindowRequestedEventArgs e){e.Handled=true;};
            core.WebMessageReceived+=delegate(object sender,Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e){string value=e.TryGetWebMessageAsString();if(value=="ready"){Ready=true;Submit();web.Focus();}else if(value=="close")Collapse();else if(value=="frame")PresentedFrames++;};
            string file=Path.Combine(config.directory,"viewer.html");File.WriteAllText(file,ViewerHtml,Encoding.UTF8);string uri=new Uri(file).AbsoluteUri;
            core.NavigationStarting+=delegate(object sender,Microsoft.Web.WebView2.Core.CoreWebView2NavigationStartingEventArgs e){if(e.Uri!=uri)e.Cancel=true;};
            core.Navigate(uri);
        }catch(Exception ex){Message="虚拟桌面渲染不可用："+ex.Message;Ready=false;Collapse();}
    }
    internal void SetFrameFile(string file,DateTime stamp){HasFrame=true;frameSource=new Uri(file).AbsoluteUri+"?v="+stamp.Ticks;Submit();}
    internal void ClearFrame(){HasFrame=false;frameSource="";Submit();}
    internal void SetProgress(double value){
        progress=Math.Max(0,Math.Min(1,value));Scale=Math.Exp(Math.Log(.08)*(1-progress));
        int w=Math.Max(1,(int)Math.Round(FullBounds.Width*Scale)),h=Math.Max(1,(int)Math.Round(FullBounds.Height*Scale));
        double cx=Anchor.X+(FullBounds.Left+FullBounds.Width/2.0-Anchor.X)*progress,cy=Anchor.Y+(FullBounds.Top+FullBounds.Height/2.0-Anchor.Y)*progress;
        ContentBounds=progress>=1?FullBounds:new Rectangle((int)Math.Round(cx-w/2),(int)Math.Round(cy-h/2),w,h);
        if(Bounds!=FullBounds)Bounds=FullBounds;Submit();
    }
    private async void Submit(){
        dirty=true;if(!Ready||busy||closed)return;busy=true;
        try{while(dirty&&!closed){dirty=false;var state=new{progress=progress,x=Anchor.X-FullBounds.Left,y=Anchor.Y-FullBounds.Top,width=FullBounds.Width,height=FullBounds.Height,src=frameSource,message=Message};await web.CoreWebView2.ExecuteScriptAsync("window.updateNewMate("+PetFiles.Json.Serialize(state)+")");}}
        catch(Exception ex){if(!closed)Message=ex.Message;}finally{busy=false;}
    }
    private const string ViewerHtml=@"<!doctype html><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content=""default-src 'none'; img-src data: file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'""><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;user-select:none}#surface{position:absolute;inset:0;background:#000;transform-origin:0 0;will-change:transform,opacity;overflow:hidden}img{position:absolute;width:100%;height:100%;object-fit:contain}#caption{position:absolute;top:12px;left:12px;padding:8px 12px;background:#000e;color:white;font:14px 'Microsoft YaHei UI',sans-serif;border-radius:8px}#caption:empty{display:none}
    </style><div id='surface'><img id='frame'><div id='caption'></div></div><script>
    const surface=document.getElementById('surface'),picture=document.getElementById('frame'),caption=document.getElementById('caption');let latest,scheduled=false,src='';
    window.updateNewMate=state=>{latest=state;if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;const s=latest,p=s.progress,k=Math.exp(Math.log(.08)*(1-p)),x=s.x*innerWidth/s.width,y=s.y*innerHeight/s.height,cx=x+(innerWidth/2-x)*p,cy=y+(innerHeight/2-y)*p;surface.style.transform='translate3d('+(cx-innerWidth*k/2)+'px,'+(cy-innerHeight*k/2)+'px,0) scale('+k+')';surface.style.opacity=Math.min(1,p*1.6);caption.textContent=s.message||'';if(s.src!==src){src=s.src;picture.src=src;picture.style.display=src?'block':'none';}window.chrome.webview.postMessage('frame');});};
    document.addEventListener('keydown',e=>{e.preventDefault();e.stopPropagation();if(e.key==='Escape'||(e.altKey&&e.key==='F4'))window.chrome.webview.postMessage('close');},true);document.addEventListener('contextmenu',e=>e.preventDefault());window.chrome.webview.postMessage('ready');
    </script>";
    protected override void Dispose(bool disposing){closed=true;if(disposing){if(frame!=null)frame.Dispose();web.Dispose();}base.Dispose(disposing);}
}

internal sealed class DesktopPet : Form {
    private readonly PetConfig config;
    private readonly string configPath;
    private readonly long ownerIdentity;
    private readonly PetFrameClock timer;
    private PetSurface surface;
    private Bitmap painted;
    private byte[] basePixels,paintPixels;
    private int pixelStride;
    private double[] outlineCos,outlineSin;
    private readonly Stopwatch clock=Stopwatch.StartNew();
    private Bitmap body, sprite;
    private readonly PetSpring stretchX=new PetSpring(0.18), stretchY=new PetSpring(0.08), reveal=new PetSpring(0);
    private readonly ContextMenuStrip sizeMenu=new ContextMenuStrip();
    private DshPetMenu dshMenu;
    private double sizeMultiplier=1;
    private DateTime settingsStamp=DateTime.MinValue;
    private long lastSettingsPoll;
    private int currentDpi, padding;
    private long appearedAt, previousTick, exitStarted=-1;
    private bool viewerOpening, allowClose, trimCanvas;
    private readonly List<Point> outline=new List<Point>();
    private readonly List<double> phases=new List<double>();
    private DesktopViewer viewer,cachedViewer;
    private Process capture;
    private DateTime captureStarted, lastFrame=DateTime.MinValue, retryAfter=DateTime.MinValue;
    private long lastStatus, lastRaise;
    private Point pressScreen, pressLocation;
    private bool pressed, dragged, expanded, anyExpanded;
    private int frameCount;
    private string captureError="";
    private string settingsError="";

    internal DesktopPet(PetConfig config, string configPath) {
        this.config=config; this.configPath=configPath; ownerIdentity=PetFiles.Identity(config.ownerPid);
        Text="NewMate";
        FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false;
        StartPosition=FormStartPosition.Manual; AutoScaleMode=AutoScaleMode.None;
        Cursor=Cursors.Hand;
        LoadScale();
        BuildBody((int)PetNative.GetDpiForSystem());
        BuildMenu();
        Rectangle area=Screen.FromPoint(Cursor.Position).WorkingArea;
        Location=new Point(area.Right-Width-24,area.Bottom-Height-24);
        timer=new PetFrameClock(this,delegate{Tick(this,EventArgs.Empty);});
        Shown+=delegate { appearedAt=previousTick=clock.ElapsedMilliseconds; Render(); WriteStatus(); timer.Start(); };
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams { get { var cp=base.CreateParams; cp.ExStyle|=0x08080088; return cp; } }
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); PetNative.MarkPet(Handle); }
    protected override void OnHandleDestroyed(EventArgs e) { PetNative.UnmarkPet(Handle); base.OnHandleDestroyed(e); }

    private void BuildBody(int dpi) {
        currentDpi=dpi;
        int margin=Math.Max(4,dpi/24), width=Math.Max(24,(int)Math.Round(120*sizeMultiplier*dpi/96));
        if (sprite==null) using (var original=new Bitmap(config.asset)) {
            int left=original.Width, top=original.Height, right=0, bottom=0;
            for (int y=0;y<original.Height;y++) for (int x=0;x<original.Width;x++) if (original.GetPixel(x,y).A>8) {
                left=Math.Min(left,x); top=Math.Min(top,y); right=Math.Max(right,x); bottom=Math.Max(bottom,y);
            }
            if (left>right) throw new InvalidOperationException("Pet image has no visible pixels.");
            sprite=original.Clone(new Rectangle(left,top,right-left+1,bottom-top+1),PixelFormat.Format32bppArgb);
        }
        int height=sprite.Height*width/sprite.Width;
        if (body!=null) body.Dispose();
        body=new Bitmap(width+margin*2,height+margin*2,PixelFormat.Format32bppArgb);
        using (var g=Graphics.FromImage(body)) {
            g.InterpolationMode=InterpolationMode.HighQualityBicubic;
            g.DrawImage(sprite,new Rectangle(margin,margin,width,height));
        }
        padding=(int)Math.Ceiling(Math.Max(body.Width,body.Height)*0.16);
        Size=new Size(body.Width+padding*2,body.Height+padding*2);
        outline.Clear(); phases.Clear();
        if(painted!=null)painted.Dispose();painted=(Bitmap)body.Clone();
        var pixels=body.LockBits(new Rectangle(Point.Empty,body.Size),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
        byte[] data=new byte[pixels.Stride*body.Height];
        int stride=pixels.Stride;
        try { Marshal.Copy(pixels.Scan0,data,0,data.Length); } finally { body.UnlockBits(pixels); }
        pixelStride=stride;basePixels=data;paintPixels=new byte[data.Length];
        int radius=Math.Max(2,(int)Math.Round(2.0*dpi/96));
        // Dilate the alpha silhouette, subtract its body: no rectangular border,
        // and no strokes around the eyes or other opaque internal details.
        for (int y=0;y<body.Height;y++) for (int x=0;x<body.Width;x++) {
            if (data[y*stride+x*4+3]>=128) continue;
            bool nearby=false;
            for (int dy=-radius;dy<=radius && !nearby;dy++) for (int dx=-radius;dx<=radius;dx++) {
                if (dx*dx+dy*dy>radius*radius) continue;
                int xx=x+dx, yy=y+dy;
                if (xx>=0 && yy>=0 && xx<body.Width && yy<body.Height && data[yy*stride+xx*4+3]>=128) { nearby=true; break; }
            }
            if (nearby) { outline.Add(new Point(x,y)); phases.Add((Math.Atan2(y-body.Height/2.0,x-body.Width/2.0)+Math.PI)/(2*Math.PI)); }
        }
        outlineCos=new double[phases.Count];outlineSin=new double[phases.Count];
        for(int i=0;i<phases.Count;i++){outlineCos[i]=Math.Cos(4*Math.PI*phases[i]);outlineSin[i]=Math.Sin(4*Math.PI*phases[i]);}
    }

    private void BuildMenu() {
        sizeMenu.ShowImageMargin=false; sizeMenu.ShowCheckMargin=true;
        sizeMenu.Items.Add(new ToolStripMenuItem("NewMate · 大小倍率") { Enabled=false });
        sizeMenu.Items.Add(new ToolStripSeparator());
        var slider=new TrackBar {Minimum=300,Maximum=3000,TickStyle=TickStyle.None,SmallChange=1,LargeChange=100,Width=260,Height=35,AutoSize=false};
        sizeMenu.Items.Add(new ToolStripControlHost(slider));
        slider.Scroll+=delegate {ChangeScale(slider.Value/1000.0);sizeMenu.Items[0].Text="NewMate · "+(sizeMultiplier*100).ToString("0.#")+"%";};
        sizeMenu.Opening+=delegate {
            slider.Value=(int)Math.Round(sizeMultiplier*1000);
            sizeMenu.Items[0].Text="NewMate · "+(sizeMultiplier*100).ToString("0.#")+"% (30%–300%)";
        };
        sizeMenu.Opened+=delegate { WriteStatus(); };
        sizeMenu.Closed+=delegate { WriteStatus(); };
    }
    private void LoadScale() {
        // Read before the first bitmap/window is built: no default-size flash.
        if (String.IsNullOrEmpty(config.settingsPath) || !File.Exists(config.settingsPath)) return;
        try {
            var saved=PetFiles.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(config.settingsPath));
            double value=Convert.ToDouble(saved["size_multiplier"]);
            if (Double.IsNaN(value) || Double.IsInfinity(value) || value<0.3 || value>3) throw new InvalidDataException("Invalid saved pet size");
            if (!saved.ContainsKey("version") || Convert.ToInt32(saved["version"])<2) value/=0.75;
            if(value>3)throw new InvalidDataException("Invalid legacy size");
            sizeMultiplier=value;settingsStamp=File.GetLastWriteTimeUtc(config.settingsPath);
        } catch (Exception ex) { settingsError=ex.Message; }
    }
    private void SaveScale() {
        if (String.IsNullOrEmpty(config.settingsPath)) return;
        string temporary=config.settingsPath+"."+Process.GetCurrentProcess().Id+".tmp";
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(config.settingsPath));
            File.WriteAllText(temporary,PetFiles.Json.Serialize(new { version=2,size_multiplier=sizeMultiplier,updated_at=DateTime.UtcNow.ToString("o") }));
            if (File.Exists(config.settingsPath)) File.Replace(temporary,config.settingsPath,null); else File.Move(temporary,config.settingsPath);
            settingsStamp=File.GetLastWriteTimeUtc(config.settingsPath);settingsError="";
        } catch (Exception ex) { settingsError=ex.Message; }
        finally { try { if(File.Exists(temporary)) File.Delete(temporary); } catch(IOException) { } }
    }
    private void ChangeScale(double factor) {ApplyScale(factor,true);}
    private void ApplyScale(double factor,bool persist) {
        if (exitStarted>=0) return;
        if(Double.IsNaN(factor)||Double.IsInfinity(factor)||factor<.3||factor>3)return;
        if (factor==sizeMultiplier) { if(persist)SaveScale(); WriteStatus(); return; }
        double anchorX=Left+Width/2.0; int anchorY=Top+Height-padding;
        int oldWidth=body.Width, oldHeight=body.Height;
        Size oldCanvas=Size;
        sizeMultiplier=Math.Max(0.3,Math.Min(3,factor));
        if(persist)SaveScale();
        if(dshMenu!=null)dshMenu.UpdateScale(sizeMultiplier);
        BuildBody(currentDpi);
        // Retain enough transparent canvas for the old visual size while shrinking
        // (including 200% -> 50%). Trim it only after the spring has settled.
        Size=new Size(Math.Max(Width,oldCanvas.Width),Math.Max(Height,oldCanvas.Height));
        trimCanvas=true;
        stretchX.Value*=oldWidth/(double)body.Width; stretchY.Value*=oldHeight/(double)body.Height;
        stretchX.Velocity*=oldWidth/(double)body.Width; stretchY.Velocity*=oldHeight/(double)body.Height;
        stretchX.Target=stretchY.Target=1;
        Location=new Point((int)Math.Round(anchorX-Width/2.0),anchorY-Height+padding);
        KeepVisible(); Render(); WriteStatus();
    }

    protected override void OnMouseDown(MouseEventArgs e) {
        base.OnMouseDown(e);
        if (e.Button!=MouseButtons.Left || exitStarted>=0) return;
        // MouseDown coordinates belong to the delivered event. Cursor.Position may
        // already be a newer physical move by the time the UI dequeues this event.
        pressed=true; dragged=false; pressScreen=PointToScreen(e.Location); pressLocation=Location; Capture=true;
        stretchX.Target=1.1; stretchY.Target=0.86;
    }
    protected override void OnMouseMove(MouseEventArgs e) {
        base.OnMouseMove(e);
        if (!pressed) return;
        Point p=Cursor.Position;
        if (Math.Abs(p.X-pressScreen.X)>SystemInformation.DragSize.Width/2 || Math.Abs(p.Y-pressScreen.Y)>SystemInformation.DragSize.Height/2) dragged=true;
        if (!dragged) return;
        Location=new Point(pressLocation.X+p.X-pressScreen.X,pressLocation.Y+p.Y-pressScreen.Y);
        Render();
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        base.OnMouseUp(e);
        if (exitStarted>=0) return;
        if (e.Button==MouseButtons.Right) {
            if(!String.IsNullOrEmpty(config.menuThemePath) && File.Exists(config.menuThemePath)) {
                if(dshMenu==null) dshMenu=new DshPetMenu(config,ChangeScale,WriteStatus,delegate(Point point){if(exitStarted<0)sizeMenu.Show(point);});
                dshMenu.Present(PointToScreen(e.Location),sizeMultiplier,Bounds);
            } else sizeMenu.Show(PointToScreen(e.Location));
            return;
        }
        if (!pressed || e.Button!=MouseButtons.Left) return;
        bool toggle=!dragged;
        if (dragged) {
            Point final=PointToScreen(e.Location);
            Location=new Point(pressLocation.X+final.X-pressScreen.X,pressLocation.Y+final.Y-pressScreen.Y);
        }
        pressed=false; Capture=false;
        stretchX.Target=stretchY.Target=1;
        KeepVisible();
        if (toggle) Toggle();
        WriteStatus();
    }
    protected override void OnMouseCaptureChanged(EventArgs e) { base.OnMouseCaptureChanged(e); if (!Capture) { pressed=false; if (exitStarted<0) stretchX.Target=stretchY.Target=1; } }
    protected override void WndProc(ref Message m) {
        if (m.Msg==0x02E0 && body!=null) { BuildBody((int)(m.WParam.ToInt64()&0xffff)); KeepVisible(); }
        base.WndProc(ref m);
    }
    private void KeepVisible() {
        Rectangle r=Screen.FromRectangle(Bounds).WorkingArea;
        Location=new Point(Math.Max(r.Left,Math.Min(Left,r.Right-Width)),Math.Max(r.Top,Math.Min(Top,r.Bottom-Height)));
    }
    private void Toggle() {
        if (exitStarted>=0) return;
        if (viewer!=null) {
            if (viewerOpening) Collapse();
            else { viewerOpening=true; reveal.Target=1; }
        }
        else Expand();
    }
    private void Expand() {
        bool reused=cachedViewer!=null;viewer=cachedViewer??new DesktopViewer(config);cachedViewer=null;viewer.Collapse=Collapse;
        viewer.FullBounds=Screen.FromRectangle(Bounds).Bounds;
        viewer.Anchor=new Point(Left+Width/2,Top+Height-padding-body.Height/2);
        reveal.Value=reveal.Velocity=0; reveal.Target=1; viewerOpening=true;
        viewer.SetProgress(0);
        if(!reused)viewer.FormClosing+=delegate(object sender, FormClosingEventArgs e) { if (expanded) { e.Cancel=true; Collapse(); } };
        expanded=true; anyExpanded=true; lastFrame=DateTime.MinValue; frameCount=0; captureError="";
        // The pet is owned by the viewer, so it remains above it even on activation.
        Owner=viewer; viewer.Show(); viewer.Activate();
        StartCapture(); PetNative.Raise(Handle); Render();
    }
    private void Collapse() {
        if (viewer==null) return;
        // If the pet was dragged or resized while open, return to its new anchor.
        // Keep an in-flight anchor when reversing so the rectangle never jumps.
        if (reveal.Value>=0.999) viewer.Anchor=new Point(Left+Width/2,Top+Height-padding-body.Height/2);
        viewerOpening=false; reveal.Target=0;
    }
    private void FinishCollapse() {
        expanded=false; Owner=null; StopCapture();
        if(viewer!=null){var old=viewer;viewer=null;old.Hide();old.ClearFrame();if(old.Ready&&exitStarted<0)cachedViewer=old;else old.Dispose();}
        anyExpanded=PetNative.AnyViewer();
        Render(); WriteStatus();
    }
    private void BeginExit() {
        if (exitStarted>=0) return;
        exitStarted=clock.ElapsedMilliseconds; sizeMenu.Close(); pressed=false; Capture=false;
        if(dshMenu!=null)dshMenu.Dismiss();
        stretchX.Target=1.08; stretchY.Target=0.88;
        Collapse(); StopCapture(); WriteStatus();
    }
    protected override void OnFormClosing(FormClosingEventArgs e) {
        if (!allowClose) { e.Cancel=true; BeginExit(); }
        base.OnFormClosing(e);
    }
    private void StartCapture() {
        try {
            string frame=Path.Combine(config.directory,"frame.png");
            if (File.Exists(frame)) File.Delete(frame);
            var info=new ProcessStartInfo(Application.ExecutablePath,"--capture \""+configPath+"\" "+Process.GetCurrentProcess().Id);
            info.UseShellExecute=false; info.CreateNoWindow=true; info.WindowStyle=ProcessWindowStyle.Hidden;
            capture=Process.Start(info); captureStarted=DateTime.UtcNow;
        } catch (Exception ex) { captureError=ex.Message; retryAfter=DateTime.UtcNow.AddSeconds(2); }
    }
    private void StopCapture() {
        if (capture==null) return;
        try { if (!capture.HasExited) { capture.Kill(); capture.WaitForExit(500); } } catch { }
        capture.Dispose(); capture=null;
    }
    private void PollCapture() {
        if (!expanded || viewer==null || exitStarted>=0 || !viewerOpening) return;
        if (capture==null) { if (DateTime.UtcNow>=retryAfter) StartCapture(); return; }
        string frame=Path.Combine(config.directory,"frame.png");
        DateTime written=File.GetLastWriteTimeUtc(frame);
        if (File.Exists(frame) && written>lastFrame) {
            try {
                viewer.SetFrameFile(frame,written);
                lastFrame=written; frameCount++; captureError=""; viewer.Message=""; viewer.SetProgress(reveal.Value);
                try {
                    var facts=PetFiles.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(config.directory,"capture.json")));
                    if (Convert.ToInt32(facts["failed"])>0) viewer.Message="部分窗口暂时无法显示";
                } catch (IOException) { } catch (ArgumentException) { }
            } catch (IOException) { } catch (ArgumentException) { }
        }
        DateTime latest=lastFrame>captureStarted ? lastFrame : captureStarted;
        if (capture.HasExited || (DateTime.UtcNow-latest).TotalSeconds>3) {
            captureError="虚拟桌面画面暂不可用，正在重试";
            viewer.ClearFrame();
            viewer.Message=captureError; viewer.Invalidate();
            StopCapture(); retryAfter=DateTime.UtcNow.AddSeconds(2);
        }
    }
    private void Tick(object sender, EventArgs e) {
        long nowTime=clock.ElapsedMilliseconds;
        if(nowTime-lastSettingsPoll>=200){
            lastSettingsPoll=nowTime;
            string transferMotion=Path.Combine(config.directory,"transfer-motion");
            if(exitStarted<0&&File.Exists(transferMotion))try{string direction=File.ReadAllText(transferMotion);File.Delete(transferMotion);stretchX.Target=stretchY.Target=1;stretchX.Velocity+=direction=="in"?-4:4;stretchY.Velocity+=direction=="in"?4:-4;}catch(IOException){}
            if (File.Exists(Path.Combine(config.directory,"stop")) || !PetFiles.Alive(config.ownerPid,ownerIdentity)) BeginExit();
            if(!String.IsNullOrEmpty(config.settingsPath) && File.Exists(config.settingsPath) && File.GetLastWriteTimeUtc(config.settingsPath)!=settingsStamp){
                double oldScale=sizeMultiplier;LoadScale();double next=sizeMultiplier;sizeMultiplier=oldScale;ApplyScale(next,false);
            }
        }
        double dt=Math.Max(0.001,Math.Min(0.064,(nowTime-previousTick)/1000.0)); previousTick=nowTime;
        if (exitStarted>=0 && nowTime-exitStarted>90) { stretchX.Target=0.04; stretchY.Target=0.02; }
        stretchX.Step(dt,23,exitStarted<0 ? 0.58 : 0.8); stretchY.Step(dt,25,exitStarted<0 ? 0.58 : 0.8);
        if (trimCanvas && !stretchX.Moving && !stretchY.Moving) {
            double anchorX=Left+Width/2.0; int anchorY=Top+Height-padding;
            Size=new Size(body.Width+padding*2,body.Height+padding*2);
            Location=new Point((int)Math.Round(anchorX-Width/2.0),anchorY-Height+padding);
            trimCanvas=false; KeepVisible(); Render();
        }
        if (viewer!=null) {
            if (viewer.Ready && reveal.Moving) { reveal.Step(dt,22,1); viewer.SetProgress(reveal.Value); }
            if (!viewerOpening && !reveal.Moving) FinishCollapse();
        }
        bool moving=stretchX.Moving || stretchY.Moving || (viewer!=null && reveal.Moving) || exitStarted>=0;
        if (moving || !anyExpanded) Render();
        if (exitStarted>=0 && nowTime-exitStarted>=650 && viewer==null) { allowClose=true; Close(); return; }
        if (nowTime-lastStatus>=250) {
            bool now=PetNative.AnyViewer();
            if (now!=anyExpanded) { anyExpanded=now; Render(); }
            if(!reveal.Moving)PollCapture(); WriteStatus(); lastStatus=clock.ElapsedMilliseconds;
        }
        if (clock.ElapsedMilliseconds-lastRaise>=1000) {
            if (viewer!=null) PetNative.Raise(viewer.Handle);
            PetNative.Raise(Handle); lastRaise=clock.ElapsedMilliseconds;
            if(dshMenu!=null && dshMenu.Open)PetNative.Raise(dshMenu.Handle);
            if (!pressed) KeepVisible();
        }
    }
    private void Render() {
        if(!IsHandleCreated || body==null)return;
        if(surface==null || surface.Bitmap.Width!=Width || surface.Bitmap.Height!=Height){if(surface!=null)surface.Dispose();surface=new PetSurface(Width,Height);}
        Buffer.BlockCopy(basePixels,0,paintPixels,0,basePixels.Length);
        if(!anyExpanded){double time=4*Math.PI*clock.Elapsed.TotalMilliseconds/3000,cos=Math.Cos(time),sin=Math.Sin(time);
            for(int i=0;i<outline.Count;i++){int offset=outline[i].Y*pixelStride+outline[i].X*4;byte value=(byte)Math.Round(127.5*(1-outlineCos[i]*cos-outlineSin[i]*sin));paintPixels[offset]=paintPixels[offset+1]=paintPixels[offset+2]=value;paintPixels[offset+3]=255;}
        }
        var bits=painted.LockBits(new Rectangle(Point.Empty,painted.Size),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
        try{Marshal.Copy(paintPixels,0,bits.Scan0,paintPixels.Length);}finally{painted.UnlockBits(bits);}
        double sx=Math.Max(.01,stretchX.Value),sy=Math.Max(.01,stretchY.Value);float w=(float)(body.Width*sx),h=(float)(body.Height*sy);
        var g=surface.Graphics;g.Clear(Color.Transparent);g.DrawImage(painted,new RectangleF((Width-w)/2,(float)(Height-padding)-h,w,h));g.Flush(FlushIntention.Sync);
        var location=new PetNative.Point(Left,Top);var origin=new PetNative.Point(0,0);
        double alpha=exitStarted<0?Math.Min(1,(clock.ElapsedMilliseconds-appearedAt)/180.0):Math.Max(0,1-(clock.ElapsedMilliseconds-exitStarted-90)/470.0);
        var size=new PetNative.Size(Width,Height);var blend=new PetNative.Blend{Alpha=(byte)Math.Round(Math.Max(0,Math.Min(1,alpha))*255),Format=1};
        if(!PetNative.UpdateLayeredWindow(Handle,IntPtr.Zero,ref location,ref size,surface.DC,ref origin,0,ref blend,2))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    private void WriteStatus() {
        try { PetFiles.WriteJson(Path.Combine(config.directory,"status.json"),new {
            kind="virtual-desktop-pet", pid=Process.GetCurrentProcess().Id, hwnd=Handle.ToInt64(),
            desktop=config.desktop, bounds=PetNative.Bounds(Bounds), expanded=expanded, outline_active=!anyExpanded,
            viewer_hwnd=viewer==null ? 0 : viewer.Handle.ToInt64(), viewer_bounds=viewer==null ? null : PetNative.Bounds(viewer.Bounds),
            viewer_transition=viewer==null ? "hidden" : (reveal.Moving ? (viewerOpening ? "opening" : "closing") : "open"),
            viewer_content_bounds=viewer==null ? null : PetNative.Bounds(viewer.ContentBounds),
            viewer_presented_frames=viewer==null ? 0 : viewer.PresentedFrames,
            viewer_progress=reveal.Value, viewer_scale=viewer==null ? 0 : viewer.Scale,
            pet_scale_x=stretchX.Value, pet_scale_y=stretchY.Value, size_multiplier=sizeMultiplier,
            paint_bounds=new { x=(Width-body.Width*stretchX.Value)/2, y=Height-padding-body.Height*stretchY.Value, width=body.Width*stretchX.Value, height=body.Height*stretchY.Value },
            settings_error=settingsError,
            pet_transition=exitStarted>=0 ? "exiting" : (clock.ElapsedMilliseconds-appearedAt<800 ? "entering" : (pressed ? "pressed" : (stretchX.Moving || stretchY.Moving ? "settling" : "idle"))),
            menu_hwnd=dshMenu!=null && dshMenu.Open ? dshMenu.Handle.ToInt64() : (sizeMenu.Visible ? sizeMenu.Handle.ToInt64() : 0),
            menu_renderer=dshMenu!=null && dshMenu.Open ? "dsh-css-webview2" : "native-fallback",
            menu_theme_hash=dshMenu==null ? "" : dshMenu.ThemeHash, menu_error=dshMenu==null ? "" : dshMenu.Error,
            capture_pid=capture==null ? 0 : capture.Id, frames=frameCount, error=captureError,
            last_frame_utc=lastFrame==DateTime.MinValue ? null : lastFrame.ToString("o"), read_only=true,
            utc=DateTime.UtcNow.ToString("o")
        }); } catch (IOException) { }
    }
    protected override void Dispose(bool disposing) {
        if (disposing) {
            timer.Stop(); timer.Dispose();
            if(surface!=null){surface.Dispose();surface=null;}if(painted!=null){painted.Dispose();painted=null;}
            StopCapture(); expanded=false; Owner=null;
            if (viewer!=null) { viewer.Dispose(); viewer=null; }
            if(cachedViewer!=null){cachedViewer.Dispose();cachedViewer=null;}
            if (body!=null) { body.Dispose(); body=null; }
            if (sprite!=null) { sprite.Dispose(); sprite=null; }
            sizeMenu.Dispose();
            if(dshMenu!=null) { dshMenu.Dispose();dshMenu=null; }
        }
        base.Dispose(disposing);
    }
}

internal static class DesktopPetProgram {
    [STAThread] private static int Main(string[] args) {
        string errorPath=null;
        try {
            PetNative.SetProcessDpiAwarenessContext(new IntPtr(-4));
            bool capture=args.Length>0 && args[0]=="--capture";
            string file=args[capture ? 1 : 0];
            PetConfig config=PetFiles.Json.Deserialize<PetConfig>(File.ReadAllText(file));
            errorPath=Path.Combine(config.directory,capture ? "capture-error.json" : "error.json");
            if (capture) DesktopCapture.Run(config,int.Parse(args[2]));
            else { Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); using (var pet=new DesktopPet(config,file)) Application.Run(pet); }
            return 0;
        } catch (Exception ex) { if (errorPath!=null) PetFiles.WriteJson(errorPath,new { error=ex.ToString() }); return 1; }
    }
}
