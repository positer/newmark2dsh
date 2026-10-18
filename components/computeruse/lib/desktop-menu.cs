// Chromium renders the DSH Menu markup and CSS cascade, including plugin overrides.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class DshPetMenu : Form {
    private readonly PetConfig config;
    private readonly Action<double> choose;
    private readonly Action changed;
    private readonly Action<Point> failed;
    private readonly Action<string> action;
    private readonly WebView2 web=new WebView2();
    private readonly Timer timer=new Timer();
    private Task initialize;
    private Point anchor;
    private Rectangle petBounds;
    private double scale;
    private DateTime revision=DateTime.MinValue;
    private DateTime attemptedRevision=DateTime.MinValue;
    private string documentUri;
    private bool loading,closed,documentReady;
    internal string Error="";
    internal string ThemeHash="";
    internal bool Open { get { return Visible && Opacity>0; } }
    internal bool Ready { get { return documentReady && !loading; } }

    internal DshPetMenu(PetConfig config,Action<double> choose,Action changed,Action<Point> failed,Action<string> action=null) {
        this.config=config; this.choose=choose; this.changed=changed;this.failed=failed;this.action=action;
        Text="NewMate · DSH 菜单"; FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; TopMost=true;
        // A color-keyed parent makes WebView2's separately composed pixels
        // click-through. The rounded native Region clips the menu; its interior
        // must remain an ordinary hit-testable HWND, including the slider track.
        StartPosition=FormStartPosition.Manual; BackColor=SystemColors.Window;
        Size=new Size(420,420); Opacity=0;
        web.Dock=DockStyle.Fill; web.DefaultBackgroundColor=Color.Transparent;
        web.CreationProperties=new CoreWebView2CreationProperties { UserDataFolder=config.menuCachePath };
        Controls.Add(web);
        timer.Interval=300; timer.Tick+=delegate { if(!loading && web.CoreWebView2!=null) Reload(false); };timer.Start();
        Deactivate+=delegate { if(!loading) Dismiss(); };
        FormClosing+=delegate(object sender,FormClosingEventArgs e) { if(!closed) {e.Cancel=true;Dismiss();} };
    }
    private async Task Initialize() {
        await web.EnsureCoreWebView2Async(null);
        if(closed)return;
        var core=web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled=false; core.Settings.AreDevToolsEnabled=false;
        core.Settings.AreBrowserAcceleratorKeysEnabled=false; core.Settings.IsStatusBarEnabled=false;
        core.Settings.IsZoomControlEnabled=false; core.Settings.IsPasswordAutosaveEnabled=false;
        core.Settings.IsGeneralAutofillEnabled=false;
        core.PermissionRequested+=delegate(object sender,CoreWebView2PermissionRequestedEventArgs e) { e.State=CoreWebView2PermissionState.Deny; };
        core.NewWindowRequested+=delegate(object sender,CoreWebView2NewWindowRequestedEventArgs e) {e.Handled=true;};
        core.NavigationStarting+=delegate(object sender,CoreWebView2NavigationStartingEventArgs e) {
            if(documentUri==null || !(e.Uri==documentUri || e.Uri.StartsWith(documentUri+"?",StringComparison.Ordinal)))e.Cancel=true;
        };
        core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All);
        core.WebResourceRequested+=delegate(object sender,CoreWebView2WebResourceRequestedEventArgs e) {
            string uri=e.Request.Uri;
            if(uri.StartsWith("data:",StringComparison.Ordinal) || (documentUri!=null && (uri==documentUri || uri.StartsWith(documentUri+"?",StringComparison.Ordinal))))return;
            e.Response=core.Environment.CreateWebResourceResponse(new MemoryStream(new byte[0]),403,"Forbidden","");
        };
        core.WebMessageReceived+=delegate(object sender,CoreWebView2WebMessageReceivedEventArgs e) {
            try {
                var message=PetFiles.Json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);
                string kind=Convert.ToString(message["kind"]);
                if(kind=="close") {Dismiss();return;}
                if(kind=="action"){string value=Convert.ToString(message["value"]);if(value!="stop-companion"&&value!="settings")return;Dismiss();if(action!=null)action(value);return;}
                if(kind=="scale") {
                    double value=Convert.ToDouble(message["value"]);
                    if(Double.IsNaN(value)||Double.IsInfinity(value)||value<.3||value>3)return;
                    scale=value;choose(value);return;
                }
                if(kind=="ready") {
                    double dpi=Convert.ToDouble(message["dpr"]);
                    if(Double.IsNaN(dpi)||Double.IsInfinity(dpi)||dpi<.5||dpi>8)return;
                    int width=(int)Math.Ceiling(Convert.ToDouble(message["width"])*dpi);
                    int height=(int)Math.Ceiling(Convert.ToDouble(message["height"])*dpi);
                    if(width<70 || width>1600 || height<70 || height>1600)throw new InvalidDataException("Invalid menu geometry");
                    var screen=Screen.FromPoint(anchor).WorkingArea;
                    Size=new Size(Math.Min(width,screen.Width),Math.Min(height,screen.Height));
                    Location=new Point(Math.Max(screen.Left,Math.Min(petBounds.Right+8+Width<=screen.Right ? petBounds.Right+8 : petBounds.Left-Width-8,screen.Right-Width)),Math.Max(screen.Top,Math.Min(anchor.Y,screen.Bottom-Height)));
                    float radius=(float)Math.Max(0,Math.Min(100,Convert.ToDouble(message["radius"])*dpi));
                    var old=Region;
                    using(var path=new GraphicsPath()) {
                        if(radius<1)path.AddRectangle(new Rectangle(Point.Empty,Size));
                        else {float d=radius*2;path.AddArc(0,0,d,d,180,90);path.AddArc(Width-d,0,d,d,270,90);path.AddArc(Width-d,Height-d,d,d,0,90);path.AddArc(0,Height-d,d,d,90,90);path.CloseFigure();}
                        Region=new Region(path);
                    }
                    if(old!=null)old.Dispose();
                    bool first=loading;loading=false;documentReady=true;Error="";changed();if(!Visible)return;Opacity=1;if(first){Activate();web.Focus();}
                }
            } catch(Exception ex) { Error=ex.Message;loading=false;changed(); }
        };
    }
    internal async void Warm() {
        // Warming creates this window handle and lets WebView2 bring its environment up. That
        // start-up can leave a HIDDEN menu host holding the desktop foreground, which silently
        // moves the user's typing target: measured, the takeover's new pet put this window
        // (title "NewMate · DSH 菜单", IsWindowVisible=false) in the foreground and
        // scripts/verify-desktop-pet.mjs failed "virtual startup does not activate a desktop
        // window" on every run. Restoring what the user was actually using costs nothing when
        // the menu is not being presented, and the presented path is untouched.
        IntPtr restore=PetNative.GetForegroundWindow();
        try { var handle=Handle; if(initialize==null)initialize=Initialize();await initialize;if(!closed)Reload(false); }
        catch(Exception ex){Error=ex.Message;loading=false;changed();}
        finally { try { if(!closed&&!Visible&&PetNative.GetForegroundWindow()==Handle)PetNative.SetForegroundWindow(restore); } catch(ObjectDisposedException) { } }
    }
    internal async void Present(Point point,double selected,Rectangle bounds) {
        anchor=point;petBounds=bounds;scale=selected;loading=true;Opacity=0;Location=point;
        try {
            Show();if(initialize==null)initialize=Initialize();await initialize;
            if(closed)return;
            if(documentReady && File.GetLastWriteTimeUtc(config.menuThemePath)==revision){
                var screen=Screen.FromPoint(anchor).WorkingArea;
                Location=new Point(Math.Max(screen.Left,Math.Min(petBounds.Right+8+Width<=screen.Right?petBounds.Right+8:petBounds.Left-Width-8,screen.Right-Width)),Math.Max(screen.Top,Math.Min(anchor.Y,screen.Bottom-Height)));
                loading=false;Opacity=1;Activate();web.Focus();changed();
            }else Reload(!documentReady);
        } catch(Exception ex) { Error=ex.Message;loading=false;Hide();changed();failed(anchor); }
    }
    private void Reload(bool force) {
        try {
            var stamp=File.GetLastWriteTimeUtc(config.menuThemePath);
            if(!force && (stamp==revision || (!documentReady && stamp==attemptedRevision)))return;
            attemptedRevision=stamp;
            var snapshot=PetFiles.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(config.menuThemePath));
            if(!Convert.ToString(snapshot["html"]).Contains("data-newmate-action"))throw new InvalidDataException("Menu snapshot requires configuration actions");
            snapshot["currentScale"]=scale;
            string json=PetFiles.Json.Serialize(snapshot).Replace("<","\\u003c").Replace("\u2028","\\u2028").Replace("\u2029","\\u2029");
            string nonce=Guid.NewGuid().ToString("N");
            string html=File.ReadAllText(config.menuShellPath).Replace("__NEWMATE_NONCE__",nonce).Replace("__NEWMATE_SNAPSHOT__",json);
            string file=Path.Combine(config.directory,"menu.html");File.WriteAllText(file,html,Encoding.UTF8);
            documentUri=new Uri(file).AbsoluteUri;loading=true;documentReady=false;revision=stamp;
            ThemeHash=snapshot.ContainsKey("hash") ? Convert.ToString(snapshot["hash"]) : "";
            web.CoreWebView2.Navigate(documentUri+"?revision="+DateTime.UtcNow.Ticks);
        } catch(Exception ex) {bool presented=Visible;Error=ex.Message;loading=false;Hide();changed();if(presented)failed(anchor);}
    }
    internal async void UpdateScale(double value) {
        scale=value;
        if(!Open || loading || web.CoreWebView2==null)return;
        try { await web.CoreWebView2.ExecuteScriptAsync("window.newmateSetScale("+value.ToString(System.Globalization.CultureInfo.InvariantCulture)+")"); }
        catch(Exception ex){Error=ex.Message;}
    }
    internal void Dismiss() {if(closed)return;loading=false;Hide();changed();}
    protected override void Dispose(bool disposing) {
        closed=true;
        if(disposing){timer.Stop();timer.Dispose();web.Dispose();}
        base.Dispose(disposing);
    }
}
