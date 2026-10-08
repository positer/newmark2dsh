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
    private readonly WebView2 web=new WebView2();
    private readonly Timer timer=new Timer();
    private Task initialize;
    private Point anchor;
    private Rectangle petBounds;
    private double scale;
    private DateTime revision=DateTime.MinValue;
    private string documentUri;
    private bool loading,closed;
    internal string Error="";
    internal string ThemeHash="";
    internal bool Open { get { return Visible && Opacity>0; } }

    internal DshPetMenu(PetConfig config,Action<double> choose,Action changed,Action<Point> failed) {
        this.config=config; this.choose=choose; this.changed=changed;this.failed=failed;
        Text="NewMate · DSH 菜单"; FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; TopMost=true;
        // A color-keyed parent makes WebView2's separately composed pixels
        // click-through. The rounded native Region clips the menu; its interior
        // must remain an ordinary hit-testable HWND, including the slider track.
        StartPosition=FormStartPosition.Manual; BackColor=SystemColors.Window;
        Size=new Size(420,420); Opacity=0;
        web.Dock=DockStyle.Fill; web.DefaultBackgroundColor=Color.Transparent;
        web.CreationProperties=new CoreWebView2CreationProperties { UserDataFolder=config.menuCachePath };
        Controls.Add(web);
        timer.Interval=300; timer.Tick+=delegate { if(Open && !loading) Reload(false); };timer.Start();
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
                    bool first=loading;loading=false;if(!Visible)return;Opacity=1;if(first){Activate();web.Focus();}Error="";changed();
                }
            } catch(Exception ex) { Error=ex.Message;loading=false;changed(); }
        };
    }
    internal async void Present(Point point,double selected,Rectangle bounds) {
        anchor=point;petBounds=bounds;scale=selected;loading=true;Opacity=0;Location=point;
        try {
            Show();if(initialize==null)initialize=Initialize();await initialize;
            if(!closed)Reload(true);
        } catch(Exception ex) { Error=ex.Message;loading=false;Hide();changed();failed(anchor); }
    }
    private void Reload(bool force) {
        try {
            var stamp=File.GetLastWriteTimeUtc(config.menuThemePath);
            if(!force && stamp==revision)return;
            var snapshot=PetFiles.Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(config.menuThemePath));
            snapshot["currentScale"]=scale;
            string json=PetFiles.Json.Serialize(snapshot).Replace("<","\\u003c").Replace("\u2028","\\u2028").Replace("\u2029","\\u2029");
            string nonce=Guid.NewGuid().ToString("N");
            string html=File.ReadAllText(config.menuShellPath).Replace("__NEWMATE_NONCE__",nonce).Replace("__NEWMATE_SNAPSHOT__",json);
            string file=Path.Combine(config.directory,"menu.html");File.WriteAllText(file,html,Encoding.UTF8);
            documentUri=new Uri(file).AbsoluteUri;loading=true;revision=stamp;
            ThemeHash=snapshot.ContainsKey("hash") ? Convert.ToString(snapshot["hash"]) : "";
            web.CoreWebView2.Navigate(documentUri+"?revision="+DateTime.UtcNow.Ticks);
        } catch(Exception ex) {Error=ex.Message;loading=false;Hide();changed();failed(anchor);}
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
