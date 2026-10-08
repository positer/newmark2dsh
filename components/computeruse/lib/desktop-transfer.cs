// Presentation transfer keeps the original process/window. Only the proxy changes desktop.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

internal sealed class TransferConfig {
    public string id {get;set;} public string directory {get;set;}
    public string ownerId {get;set;}
    public string sourceDesktop {get;set;} public string targetDesktop {get;set;}
    public string sourceHandle {get;set;} public int sourcePid {get;set;} public string sourceStart {get;set;}
    public string side {get;set;} public string title {get;set;} public int ownerPid {get;set;}
    public int x {get;set;} public int y {get;set;} public int width {get;set;} public int height {get;set;}
    public int anchorX {get;set;} public int anchorY {get;set;}
    public int jobSourcePid {get;set;} public string jobSourceStart {get;set;} public string jobHandle {get;set;}
    public int brokerPid {get;set;} public string brokerStart {get;set;} public bool resume {get;set;}
    public string animation {get;set;} public string image {get;set;}
    public string animationDesktop {get;set;} public string animationPrevious {get;set;} public bool animationTopmost {get;set;}
    public int sourceX {get;set;} public int sourceY {get;set;} public long sourceStyle {get;set;}
}
internal static class TransferNative {
    internal struct Rect {public int L,T,R,B;}
    [StructLayout(LayoutKind.Sequential)] internal struct Point {public int X,Y;public Point(int x,int y){X=x;Y=y;}}
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern IntPtr OpenDesktop(string name,int flags,bool inherit,uint access);
    [DllImport("user32.dll",SetLastError=true)] internal static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll")] internal static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] internal static extern bool ScreenToClient(IntPtr hwnd,ref Point point);
    [DllImport("user32.dll")] internal static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
    [DllImport("user32.dll")] internal static extern IntPtr ChildWindowFromPointEx(IntPtr hwnd,Point point,uint flags);
    [DllImport("user32.dll")] internal static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern IntPtr GetWindow(IntPtr hwnd,uint command);
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] internal static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
    [DllImport("user32.dll",EntryPoint="SetWindowLongPtrW",SetLastError=true)] static extern IntPtr SetWindowLongPtr(IntPtr hwnd,int index,IntPtr value);
    [DllImport("user32.dll",SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr RemoveProp(IntPtr hwnd,string key);
    internal static void Conceal(IntPtr hwnd,TransferConfig c){
        if(c.sourceDesktop=="Default"){
            IntPtr dpi=PetNative.SetThreadDpiAwarenessContext(new IntPtr(-4));
            try{SetWindowLongPtr(hwnd,-20,new IntPtr((c.sourceStyle|0x80)&~0x40000L));if(!SetWindowPos(hwnd,IntPtr.Zero,-16000,-16000,0,0,0x35))throw new InvalidOperationException("Cannot park original window: "+Marshal.GetLastWin32Error());}
            finally{PetNative.SetThreadDpiAwarenessContext(dpi);}
        }
        if(!PetNative.SetProp(hwnd,"Newmark2DSH.TransferSource",new IntPtr(1)))throw new InvalidOperationException("Cannot mark original window for presentation");
    }
    internal static void Restore(IntPtr hwnd,TransferConfig c){
        RemoveProp(hwnd,"Newmark2DSH.TransferSource");
        if(c.sourceDesktop=="Default"){IntPtr dpi=PetNative.SetThreadDpiAwarenessContext(new IntPtr(-4));try{SetWindowLongPtr(hwnd,-20,new IntPtr(c.sourceStyle));SetWindowPos(hwnd,IntPtr.Zero,c.sourceX,c.sourceY,0,0,0x35);}finally{PetNative.SetThreadDpiAwarenessContext(dpi);}}
        ShowWindow(hwnd,4);
    }
    [DllImport("user32.dll")] internal static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr wp,IntPtr lp);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] internal static extern int GetClassName(IntPtr hwnd,StringBuilder text,int length);
    internal delegate bool EnumChild(IntPtr hwnd,IntPtr data);
    [DllImport("user32.dll")] internal static extern bool EnumChildWindows(IntPtr hwnd,EnumChild callback,IntPtr data);
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool DuplicateHandle(IntPtr from,IntPtr handle,IntPtr to,out IntPtr copied,uint access,bool inherit,uint options);
    internal static IntPtr Handle(string value){return new IntPtr(Convert.ToInt64(value.StartsWith("0x")?value.Substring(2):value,16));}
    internal static string Hex(IntPtr value){return "0x"+value.ToInt64().ToString("x");}
    internal static string Start(int pid){using(var p=Process.GetProcessById(pid))return p.StartTime.ToFileTimeUtc().ToString(CultureInfo.InvariantCulture);}
    internal static bool Alive(int pid,string start){try{return Start(pid)==start;}catch{return false;}}
    internal static IntPtr Enter(string desktop){IntPtr hold=OpenDesktop(desktop,0,false,0x000F01FF);if(hold==IntPtr.Zero||!SetThreadDesktop(hold))throw new InvalidOperationException("Desktop access failed: "+Marshal.GetLastWin32Error());return hold;}
    internal static IntPtr CopyJob(TransferConfig c){
        if(c.jobSourcePid==0||String.IsNullOrEmpty(c.jobHandle)||c.jobHandle=="0x0")return IntPtr.Zero;
        if(!Alive(c.jobSourcePid,c.jobSourceStart))throw new InvalidOperationException("Job holder identity changed");
        IntPtr source=OpenProcess(0x40,false,c.jobSourcePid),copy;
        try{if(source==IntPtr.Zero||!DuplicateHandle(source,Handle(c.jobHandle),GetCurrentProcess(),out copy,0,false,2))throw new InvalidOperationException("Cannot retain application job: "+Marshal.GetLastWin32Error());return copy;}
        finally{if(source!=IntPtr.Zero)CloseHandle(source);}
    }
    internal static void Save(TransferConfig c,string name,object value){PetFiles.WriteJson(Path.Combine(c.directory,name),value);}
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint length,out uint returned);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int kind,IntPtr data,int length,out int returned);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
    // Only members of our retained job are eligible. Capture process handles before terminating
    // so PID reuse cannot redirect cleanup. Preserve every live mapping and its descendants.
    internal static int[] CleanupJob(TransferConfig c,IntPtr job){
        var kept=new HashSet<int>();var handles=new Dictionary<int,IntPtr>();var parents=new Dictionary<int,int>();
        if(job==IntPtr.Zero)return new int[0];
        foreach(string dir in Directory.GetDirectories(Path.GetDirectoryName(c.directory)))try{
            string file=Path.Combine(dir,"config.json");if(!File.Exists(file))continue;
            var other=PetFiles.Json.Deserialize<TransferConfig>(File.ReadAllText(file));
            if(other.sourceDesktop!=c.sourceDesktop||!Alive(other.sourcePid,other.sourceStart))continue;
            var status=PetFiles.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(dir,"status.json")));
            string state=Convert.ToString(status["state"]);
            if(state!="returned"&&state!="handed-off"&&state!="source-closed")kept.Add(other.sourcePid);
        }catch{}
        IntPtr memory=Marshal.AllocHGlobal(1024*1024);
        try{uint returned;if(!QueryInformationJobObject(job,3,memory,1024*1024,out returned))throw new InvalidOperationException("Cannot enumerate retained job");
            int assigned=Marshal.ReadInt32(memory),count=Marshal.ReadInt32(memory,4);if(assigned!=count)throw new InvalidOperationException("Incomplete retained job enumeration");
            for(int i=0;i<count;i++){int pid=(int)Marshal.ReadIntPtr(memory,8+i*IntPtr.Size).ToInt64();IntPtr h=OpenProcess(0x1000|0x400|1,false,pid);if(h==IntPtr.Zero)continue;handles[pid]=h;
                IntPtr info=Marshal.AllocHGlobal(6*IntPtr.Size);try{int size;if(NtQueryInformationProcess(h,0,info,6*IntPtr.Size,out size)==0)parents[pid]=(int)Marshal.ReadIntPtr(info,5*IntPtr.Size).ToInt64();}finally{Marshal.FreeHGlobal(info);}}
            bool changed;do{changed=false;foreach(var pair in parents)if(kept.Contains(pair.Value)&&kept.Add(pair.Key))changed=true;}while(changed);
            foreach(var pair in handles)if(!kept.Contains(pair.Key))TerminateProcess(pair.Value,0);
            var result=new int[kept.Count];kept.CopyTo(result);return result;
        }finally{Marshal.FreeHGlobal(memory);foreach(IntPtr h in handles.Values)CloseHandle(h);}
    }
}

internal sealed class TransferBroker : Form {
    readonly TransferConfig config;readonly IntPtr source,job;
    readonly object frameLock=new object();readonly ConcurrentQueue<Action> commands=new ConcurrentQueue<Action>();
    readonly PetFrameClock timer;
    readonly System.Threading.Timer controlTimer;int controlPending;
    IntPtr outputMonitor;
    Bitmap frame;Thread worker;volatile bool stopping,prepared,concealed;bool active,returning,sourceGone,allowClose;
    IntPtr focused;string state="starting",error="",lastCommand="";long frames,painted;DateTime lastFrame,lastStatus;
    internal TransferBroker(TransferConfig c,IntPtr job){
        config=c;this.job=job;source=TransferNative.Handle(c.sourceHandle);focused=source;
        timer=new PetFrameClock(this,delegate{outputMonitor=PetNative.MonitorFromWindow(Handle,2);if(active)Invalidate();});
        // Commands and liveness must progress even when display vblank is suspended.
        // WM_TIMER is low priority and can starve behind high-refresh WM_PAINT.
        controlTimer=new System.Threading.Timer(delegate{
            if(stopping||IsDisposed||!IsHandleCreated||Interlocked.CompareExchange(ref controlPending,1,0)!=0)return;
            try{BeginInvoke(new Action(delegate{try{if(!stopping&&!IsDisposed)Tick(null,EventArgs.Empty);}finally{Interlocked.Exchange(ref controlPending,0);}}));}
            catch(InvalidOperationException){Interlocked.Exchange(ref controlPending,0);}
        },null,Timeout.Infinite,Timeout.Infinite);
        Text=(c.title??"Application")+" · NewMate";StartPosition=FormStartPosition.Manual;AutoScaleMode=AutoScaleMode.None;
        Bounds=new Rectangle(c.x,c.y,Math.Max(160,c.width),Math.Max(100,c.height));KeyPreview=true;DoubleBuffered=true;BackColor=Color.FromArgb(28,28,28);
        Shown+=delegate{Hide();worker=new Thread(CaptureLoop);worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();timer.Start();controlTimer.Change(0,100);};
    }
    bool SourceAlive(){uint pid;return TransferNative.GetWindowThreadProcessId(source,out pid)!=0&&pid==config.sourcePid&&TransferNative.Alive(config.sourcePid,config.sourceStart);}
    void CaptureLoop(){
        IntPtr desktop=IntPtr.Zero,previousDpi=IntPtr.Zero;
        try{
            desktop=TransferNative.Enter(config.sourceDesktop);
            if(!SourceAlive())throw new InvalidOperationException("Original window/process identity changed");
            previousDpi=PetNative.SetThreadDpiAwarenessContext(PetNative.GetWindowDpiAwarenessContext(source));
            if(TransferNative.IsIconic(source))throw new InvalidOperationException("Restore the minimized source window before transferring it");
            TransferNative.EnumChildWindows(source,delegate(IntPtr hwnd,IntPtr data){var cls=new StringBuilder(128);TransferNative.GetClassName(hwnd,cls,128);if(cls.ToString().IndexOf("edit",StringComparison.OrdinalIgnoreCase)>=0)focused=hwnd;return true;},IntPtr.Zero);
            using(var sync=new PetVBlank())while(!stopping){
                Action action;while(commands.TryDequeue(out action))action();
                if(!SourceAlive()){sourceGone=true;break;}
                TransferNative.Rect rect;if(!TransferNative.GetClientRect(source,out rect))throw new InvalidOperationException("Cannot read original client bounds");
                int width=rect.R-rect.L,height=rect.B-rect.T;if(width<1||height<1||width>8192||height>8192)throw new InvalidOperationException("Unsupported source dimensions");
                var next=new Bitmap(width,height,PixelFormat.Format32bppArgb);bool ok;
                using(var g=Graphics.FromImage(next)){g.Clear(Color.FromArgb(28,28,28));IntPtr dc=g.GetHdc();try{ok=TransferNative.PrintWindow(source,dc,3);}finally{g.ReleaseHdc(dc);}}
                if(!ok){next.Dispose();if(prepared){Thread.Sleep(100);continue;}throw new InvalidOperationException("The application does not support PrintWindow presentation");}
                lock(frameLock){if(frame!=null)frame.Dispose();frame=next;frames++;lastFrame=DateTime.UtcNow;if(!prepared){next.Save(Path.Combine(config.directory,"frame.png"),ImageFormat.Png);prepared=true;}}
                sync.Wait(outputMonitor);
            }
        }catch(Exception ex){error=ex.Message;}
        finally{if(returning&&SourceAlive())TransferNative.Restore(source,config);if(previousDpi!=IntPtr.Zero)PetNative.SetThreadDpiAwarenessContext(previousDpi);if(desktop!=IntPtr.Zero)TransferNative.CloseDesktop(desktop);}
    }
    void Tick(object sender,EventArgs e){
        if(sourceGone||!SourceAlive()){allowClose=true;state="source-closed";Close();return;}
        if(!String.IsNullOrEmpty(error)){state="error";WriteStatus();if(!active){allowClose=true;Close();}return;}
        if(prepared&&state=="starting"){state="prepared";WriteStatus();if(config.resume)ActivateProxy();}
        string file=Path.Combine(config.directory,"command.json");
        if(File.Exists(file))try{
            var value=PetFiles.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(file));string id=Convert.ToString(value["id"]),op=Convert.ToString(value["op"]);
            if(id!=lastCommand){lastCommand=id;
                if(op=="conceal"){commands.Enqueue(delegate{if(SourceAlive()){TransferNative.Conceal(source,config);concealed=true;}});state="concealing";}
                else if(op=="show")ActivateProxy();
                else if(op=="park"){lock(frameLock){if(frame!=null)frame.Save(Path.Combine(config.directory,"frame.png"),ImageFormat.Png);}Hide();active=false;state="parked";}
                else if(op=="return"||op=="handoff"){returning=op=="return";state=op=="return"?"returned":"handed-off";allowClose=true;Close();return;}
            }
        }catch(IOException){}catch(Exception ex){error=ex.Message;}
        if(state=="concealing"&&concealed)state="concealed";
        if(active&&(DateTime.UtcNow-lastFrame).TotalSeconds>5)Text=(config.title??"Application")+" · NewMate（画面更新等待中）";
        if((DateTime.UtcNow-lastStatus).TotalMilliseconds>=200)WriteStatus();
    }
    void ActivateProxy(){if(!concealed){commands.Enqueue(delegate{if(SourceAlive()){TransferNative.Conceal(source,config);concealed=true;}});}active=true;state="active";Show();if(config.side=="real")Activate();WriteStatus();}
    void WriteStatus(){lastStatus=DateTime.UtcNow;TransferNative.Save(config,"status.json",new{id=config.id,state,pid=Process.GetCurrentProcess().Id,start=TransferNative.Start(Process.GetCurrentProcess().Id),hwnd=TransferNative.Hex(Handle),source_pid=config.sourcePid,source_start=config.sourceStart,source_handle=config.sourceHandle,source_desktop=config.sourceDesktop,target_desktop=config.targetDesktop,side=config.side,frames,painted,concealed,job_handle=TransferNative.Hex(job),original_process_restarted=false,window_migrated=false,interactive_mapping=true,error,last_command=lastCommand,bounds=new{x=Left,y=Top,width=Width,height=Height},utc=DateTime.UtcNow.ToString("o")});}
    protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);lock(frameLock){if(frame!=null&&(DateTime.UtcNow-lastFrame).TotalSeconds<=5)e.Graphics.DrawImage(frame,ClientRectangle);else TextRenderer.DrawText(e.Graphics,"NewMate: waiting for the original window to render",Font,ClientRectangle,Color.White,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);}painted++;}
    void Pointer(MouseEventArgs e,uint message,int flags){
        int x,y;lock(frameLock){if(frame==null)return;x=e.X*frame.Width/Math.Max(1,ClientSize.Width);y=e.Y*frame.Height/Math.Max(1,ClientSize.Height);}
        commands.Enqueue(delegate{
            if(!SourceAlive())return;var screen=new TransferNative.Point(x,y);TransferNative.ClientToScreen(source,ref screen);IntPtr target=source;
            for(int i=0;i<12;i++){var local=screen;TransferNative.ScreenToClient(target,ref local);IntPtr child=TransferNative.ChildWindowFromPointEx(target,local,2);if(child==IntPtr.Zero||child==target)break;target=child;}
            var pt=screen;TransferNative.ScreenToClient(target,ref pt);if(message==0x201||message==0x204){focused=target;TransferNative.PostMessage(target,0x7,IntPtr.Zero,IntPtr.Zero);}
            long lp=((pt.Y&0xffff)<<16)|(pt.X&0xffff);if(message==0x20A)lp=((screen.Y&0xffff)<<16)|(screen.X&0xffff);
            TransferNative.PostMessage(target,message,new IntPtr(flags),new IntPtr(lp));
        });
    }
    protected override void OnMouseDown(MouseEventArgs e){base.OnMouseDown(e);Capture=true;Pointer(e,e.Button==MouseButtons.Right?0x204u:0x201u,e.Button==MouseButtons.Right?2:1);}
    protected override void OnMouseUp(MouseEventArgs e){base.OnMouseUp(e);Pointer(e,e.Button==MouseButtons.Right?0x205u:0x202u,0);Capture=false;}
    protected override void OnMouseMove(MouseEventArgs e){base.OnMouseMove(e);Pointer(e,0x200,e.Button==MouseButtons.Left?1:0);}
    protected override void OnMouseWheel(MouseEventArgs e){base.OnMouseWheel(e);Pointer(e,0x20A,e.Delta<<16);}
    protected override void OnKeyDown(KeyEventArgs e){base.OnKeyDown(e);commands.Enqueue(delegate{if(SourceAlive())TransferNative.PostMessage(focused,0x100,new IntPtr((int)e.KeyCode),new IntPtr(1));});}
    protected override void OnKeyUp(KeyEventArgs e){base.OnKeyUp(e);commands.Enqueue(delegate{if(SourceAlive())TransferNative.PostMessage(focused,0x101,new IntPtr((int)e.KeyCode),new IntPtr(unchecked((int)0xc0000001)));});}
    protected override void OnKeyPress(KeyPressEventArgs e){base.OnKeyPress(e);char value=e.KeyChar;commands.Enqueue(delegate{if(SourceAlive())TransferNative.PostMessage(focused,0x102,new IntPtr(value),new IntPtr(1));});e.Handled=true;}
    protected override void OnFormClosing(FormClosingEventArgs e){
        if(!allowClose){e.Cancel=true;commands.Enqueue(delegate{if(SourceAlive())TransferNative.PostMessage(source,0x10,IntPtr.Zero,IntPtr.Zero);});return;}
        controlTimer.Change(Timeout.Infinite,Timeout.Infinite);timer.Stop();stopping=true;worker.Join(800);if(returning&&concealed){var restore=new Thread(new ThreadStart(delegate{IntPtr d=IntPtr.Zero;try{d=TransferNative.Enter(config.sourceDesktop);if(SourceAlive())TransferNative.Restore(source,config);}finally{if(d!=IntPtr.Zero)TransferNative.CloseDesktop(d);}}));restore.Start();restore.Join(1000);}
        WriteStatus();base.OnFormClosing(e);
    }
    protected override void Dispose(bool disposing){if(disposing){controlTimer.Dispose();timer.Dispose();lock(frameLock){if(frame!=null)frame.Dispose();}}base.Dispose(disposing);}
}

internal static class TransferGuardian {
    internal static void Run(TransferConfig c){
        IntPtr job=TransferNative.CopyJob(c),desktop=IntPtr.Zero;int recoveries=0;bool cleaned=false;string ownerIdentity="";try{ownerIdentity=TransferNative.Start(c.ownerPid);}catch{}
        try{
            desktop=TransferNative.Enter(c.sourceDesktop);IntPtr source=TransferNative.Handle(c.sourceHandle);
            TransferNative.Save(c,"guardian.json",new{pid=Process.GetCurrentProcess().Id,start=TransferNative.Start(Process.GetCurrentProcess().Id),job_handle=TransferNative.Hex(job),ready=true});
            while(TransferNative.Alive(c.sourcePid,c.sourceStart)){
                uint sourcePid;if(TransferNative.GetWindowThreadProcessId(source,out sourcePid)==0||sourcePid!=c.sourcePid)break;
                bool broker=TransferNative.Alive(c.brokerPid,c.brokerStart),owner=c.ownerPid>0;
                owner=owner&&TransferNative.Alive(c.ownerPid,ownerIdentity);
                if(File.Exists(Path.Combine(c.directory,"owner-release")))owner=false;
                if(!owner&&!cleaned&&job!=IntPtr.Zero){TransferNative.Save(c,"cleanup.json",new{preserved=TransferNative.CleanupJob(c,job)});cleaned=true;}
                string state="";try{var status=PetFiles.Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(c.directory,"status.json")));state=Convert.ToString(status["state"]);}catch{}
                if(!broker&&(state=="returned"||state=="handed-off"||state=="source-closed"))break;
                if(c.side=="virtual"&&!owner){
                    if(c.sourceDesktop=="Default"){TransferNative.Restore(source,c);if(broker)using(var p=Process.GetProcessById(c.brokerPid))p.Kill();break;}
                    if(broker)using(var p=Process.GetProcessById(c.brokerPid))p.Kill();broker=false;c.targetDesktop="Default";c.side="real";
                }
                if(!broker){
                    if(c.sourceDesktop=="Default"&&c.side=="virtual"){TransferNative.Restore(source,c);break;}
                    if(state=="error"&&recoveries==0&&owner){TransferNative.Restore(source,c);break;}
                    c.resume=true;c.jobSourcePid=Process.GetCurrentProcess().Id;c.jobSourceStart=TransferNative.Start(c.jobSourcePid);c.jobHandle=TransferNative.Hex(job);
                    string file=Path.Combine(c.directory,"config.json");PetFiles.WriteJson(file,c);
                    var info=new ProcessStartInfo(Application.ExecutablePath,"--broker \""+file+"\""){UseShellExecute=false,CreateNoWindow=true};
                    using(var p=Process.Start(info)){c.brokerPid=p.Id;c.brokerStart=TransferNative.Start(p.Id);}recoveries++;Thread.Sleep(1500);
                }
                Thread.Sleep(150);
            }
        }finally{if(desktop!=IntPtr.Zero)TransferNative.CloseDesktop(desktop);if(job!=IntPtr.Zero)TransferNative.CloseHandle(job);TransferNative.Save(c,"guardian-exit.json",new{at=DateTime.UtcNow.ToString("o"),recoveries});}
    }
}

internal sealed class TransferAnimation : Form {
    readonly TransferConfig config;readonly WebView2 web=new WebView2();readonly System.Windows.Forms.Timer timeout=new System.Windows.Forms.Timer{Interval=12000};
    readonly System.Windows.Forms.Timer layerTimer=new System.Windows.Forms.Timer{Interval=30};
    string layerName="real-window";bool previewExpanded;
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{var p=base.CreateParams;p.ExStyle|=0x08000000|0x20|0x80;return p;}}
    // Follow the visible side of the transfer. Never elevate a covered real
    // source above its covering windows, or collapse a preview to make room.
    internal void ApplyLayer(){
        if(!IsHandleCreated||IsDisposed)return;
        IntPtr viewer=IntPtr.Zero;
        PetNative.EnumWindows(delegate(IntPtr h,IntPtr data){
            if(PetNative.IsWindowVisible(h)&&PetNative.GetProp(h,"Newmark.ComputerUse.ReadOnlyViewer")!=IntPtr.Zero){viewer=h;return false;}return true;
        },IntPtr.Zero);
        previewExpanded=viewer!=IntPtr.Zero;
        bool virtualSource=!String.Equals(config.animationDesktop,"Default",StringComparison.OrdinalIgnoreCase);
        bool top=config.animationTopmost;IntPtr previous=IntPtr.Zero;
        if(virtualSource&&previewExpanded){
            layerName="virtual-preview";top=(TransferNative.GetWindowLongPtr(viewer,-20).ToInt64()&8)!=0;
            previous=TransferNative.GetWindow(viewer,3);
            if(previous==Handle)previous=TransferNative.GetWindow(Handle,3);
        }else{
            layerName=virtualSource?"real-desktop":"real-window";
            // A hidden desktop's z-order handles cannot be used on Default.
            if(!virtualSource&&!String.IsNullOrEmpty(config.animationPrevious))previous=TransferNative.Handle(config.animationPrevious);
            if(virtualSource)top=false;
        }
        if(previous==Handle||!TransferNative.IsWindow(previous))previous=IntPtr.Zero;
        if(previous!=IntPtr.Zero&&((TransferNative.GetWindowLongPtr(previous,-20).ToInt64()&8)!=0)!=top)previous=IntPtr.Zero;
        if(TopMost!=top)TopMost=top;
        PetNative.SetWindowPos(Handle,previous!=IntPtr.Zero?previous:new IntPtr(top?-1:-2),0,0,0,0,0x13);
    }
    internal TransferAnimation(TransferConfig c){config=c;AutoScaleMode=AutoScaleMode.None;FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;StartPosition=FormStartPosition.Manual;Bounds=SystemInformation.VirtualScreen;BackColor=Color.Magenta;TransparencyKey=Color.Magenta;web.DefaultBackgroundColor=Color.Transparent;web.Dock=DockStyle.Fill;web.CreationProperties=new CoreWebView2CreationProperties{UserDataFolder=Path.Combine(c.directory,"animation-cache")};Controls.Add(web);Shown+=Initialize;layerTimer.Tick+=delegate{ApplyLayer();};layerTimer.Start();timeout.Tick+=delegate{TransferNative.Save(config,"animation-error.json",new{error="animation_timeout"});Close();};timeout.Start();}
    async void Initialize(object sender,EventArgs e){try{
        await web.EnsureCoreWebView2Async(null);var core=web.CoreWebView2;core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.AreDevToolsEnabled=false;core.Settings.AreBrowserAcceleratorKeysEnabled=false;
        core.PermissionRequested+=delegate(object s,Microsoft.Web.WebView2.Core.CoreWebView2PermissionRequestedEventArgs a){a.State=Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Deny;};core.NewWindowRequested+=delegate(object s,Microsoft.Web.WebView2.Core.CoreWebView2NewWindowRequestedEventArgs a){a.Handled=true;};
        core.WebMessageReceived+=delegate(object s,Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs a){var receipt=PetFiles.Json.Deserialize<Dictionary<string,object>>(a.WebMessageAsJson);receipt["layer"]=layerName;receipt["preview_expanded"]=previewExpanded;receipt["topmost"]=TopMost;PetFiles.WriteJson(Path.Combine(config.directory,"animation-result.json"),receipt);timeout.Stop();Close();};
        string data=Convert.ToBase64String(File.ReadAllBytes(config.image));
        var geometry=new{from=new{x=config.anchorX-Left,y=config.anchorY-Top,scale=.06},to=new{x=config.x-Left+config.width/2,y=config.y-Top+config.height/2,scale=1},w=config.width,h=config.height,reverse=config.animation=="in"};
        string html="<!doctype html><meta http-equiv='Content-Security-Policy' content=\"default-src 'none';img-src data:;style-src 'unsafe-inline';script-src 'unsafe-inline'\"><style>html,body{margin:0;background:transparent;overflow:hidden}img{position:absolute;left:0;top:0;transform-origin:center;will-change:transform,opacity;border-radius:10px;box-shadow:0 16px 45px #0007}</style><img id='frame' src='data:image/png;base64,"+data+"'><script>const g="+PetFiles.Json.Serialize(geometry)+";const d=devicePixelRatio||1;g.w/=d;g.h/=d;for(const p of [g.from,g.to]){p.x/=d;p.y/=d}const el=document.getElementById('frame');el.style.width=g.w+'px';el.style.height=g.h+'px';let stamps=[];function css(p){let q=1-Math.pow(1-p,3);if(g.reverse)q=1-q;let scale=Math.exp(Math.log(.06)*(1-q));let x=g.from.x+(g.to.x-g.from.x)*q-g.w/2,y=g.from.y+(g.to.y-g.from.y)*q-g.h/2;el.style.transform=`translate3d(${x}px,${y}px,0) scale(${scale})`;el.style.opacity=Math.min(1,q*4+.05)}css(0);const play=()=>{let start;function tick(t){if(start===undefined)start=t;stamps.push(t);let p=Math.min(1,(t-start)/560);css(p);if(p<1)requestAnimationFrame(tick);else{let dt=stamps.slice(1).map((t,i)=>t-stamps[i]).sort((a,b)=>a-b);chrome.webview.postMessage({completed:true,frames:stamps.length,elapsed_ms:t-start,p95_ms:dt[Math.floor(dt.length*.95)]||0,direction:g.reverse?'in':'out'})}}requestAnimationFrame(tick)};if(el.complete)play();else el.onload=play;</script>";
        string file=Path.Combine(config.directory,"animation.html");File.WriteAllText(file,html);string uri=new Uri(file).AbsoluteUri;core.NavigationStarting+=delegate(object s,Microsoft.Web.WebView2.Core.CoreWebView2NavigationStartingEventArgs a){if(a.Uri!=uri)a.Cancel=true;};core.Navigate(uri);
    }catch(Exception ex){TransferNative.Save(config,"animation-error.json",new{error=ex.Message});Close();}}
    protected override void Dispose(bool disposing){if(disposing){timeout.Dispose();layerTimer.Dispose();web.Dispose();}base.Dispose(disposing);}
}

internal static class TransferProgram {
    [MTAThread] static int Main(string[] args){
        if(args.Length!=2)return 2;var c=PetFiles.Json.Deserialize<TransferConfig>(File.ReadAllText(args[1]));
        try{
            PetNative.SetProcessDpiAwarenessContext(new IntPtr(-4));
            if(args[0]=="--inspect"){
                IntPtr d=TransferNative.Enter(c.sourceDesktop);
                try{uint pid;IntPtr h=TransferNative.Handle(c.sourceHandle);if(TransferNative.GetWindowThreadProcessId(h,out pid)==0)throw new InvalidOperationException("Window no longer exists");
                    PetNative.Rect rect;PetNative.GetWindowRect(h,out rect);
                    TransferNative.Save(c,"inspection.json",new{pid,start=TransferNative.Start((int)pid),job_start=c.jobSourcePid>0?TransferNative.Start(c.jobSourcePid):"",visible=TransferNative.IsWindowVisible(h),minimized=TransferNative.IsIconic(h),x=rect.Left,y=rect.Top,width=rect.Right-rect.Left,height=rect.Bottom-rect.Top,style=TransferNative.GetWindowLongPtr(h,-20).ToInt64(),topmost=(TransferNative.GetWindowLongPtr(h,-20).ToInt64()&8)!=0,previous=TransferNative.Hex(TransferNative.GetWindow(h,3))});
                }finally{TransferNative.CloseDesktop(d);}return 0;
            }
            if(args[0]=="--guardian"){TransferGuardian.Run(c);return 0;}
            if(args[0]=="--cleanup"){IntPtr cleanupJob=TransferNative.CopyJob(c);try{TransferNative.Save(c,"cleanup.json",new{preserved=TransferNative.CleanupJob(c,cleanupJob)});}finally{if(cleanupJob!=IntPtr.Zero)TransferNative.CloseHandle(cleanupJob);}return 0;}
            if(args[0]=="--animate"){var animationThread=new Thread(new ThreadStart(delegate{Application.EnableVisualStyles();Application.Run(new TransferAnimation(c));}));animationThread.SetApartmentState(ApartmentState.STA);animationThread.Start();animationThread.Join();return File.Exists(Path.Combine(c.directory,"animation-result.json"))?0:1;}
            IntPtr job=TransferNative.CopyJob(c),desktop=IntPtr.Zero;
            try{desktop=TransferNative.Enter(c.targetDesktop);Application.EnableVisualStyles();Application.Run(new TransferBroker(c,job));}
            finally{if(job!=IntPtr.Zero)TransferNative.CloseHandle(job);if(desktop!=IntPtr.Zero)TransferNative.CloseDesktop(desktop);}return 0;
        }catch(Exception ex){TransferNative.Save(c,"fatal.json",new{error=ex.ToString()});return 1;}
    }
}
