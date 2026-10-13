import Foundation
import AppKit

final class ScrollContent:NSView {override var isFlipped:Bool{true}}

@MainActor final class Fixture:NSObject,NSApplicationDelegate {
    var window:NSWindow?,field:NSTextField?,button:NSButton?,scroll:NSScrollView?,timer:Timer?,folder="",title="",counter=0
    func applicationDidFinishLaunching(_ notification:Notification){
        guard CommandLine.arguments.count==3 else{NSApplication.shared.terminate(nil);return};title=CommandLine.arguments[1];folder=CommandLine.arguments[2]
        let rect=NSRect(x:title.contains("User") ? 80:460,y:240,width:320,height:200),w=NSWindow(contentRect:rect,styleMask:[.titled,.closable],backing:.buffered,defer:false);w.title=title;w.isReleasedWhenClosed=false
        let root=NSView(frame:NSRect(origin:.zero,size:rect.size)),text=NSTextField(string:"fixture");text.frame=NSRect(x:20,y:110,width:260,height:32);text.isEditable=true;root.addSubview(text);field=text
        text.setAccessibilityLabel("Fixture input")
        let scroller=NSScrollView(frame:NSRect(x:20,y:65,width:270,height:35)),document=ScrollContent(frame:NSRect(x:0,y:0,width:250,height:500));scroller.hasVerticalScroller=true;scroller.documentView=document;root.addSubview(scroller);scroll=scroller
        let secure=NSSecureTextField(string:"fixture-secret");secure.frame=NSRect(x:180,y:30,width:120,height:30);secure.setAccessibilityLabel("Secure fixture");root.addSubview(secure)
        let press=NSButton(title:"Increment",target:self,action:#selector(increment));press.frame=NSRect(x:20,y:30,width:150,height:40);root.addSubview(press);button=press;w.contentView=root;window=w;w.makeKeyAndOrderFront(nil);NSApplication.shared.activate(ignoringOtherApps:true);w.makeFirstResponder(text)
        timer=Timer.scheduledTimer(withTimeInterval:0.1,repeats:true){[weak self] _ in MainActor.assumeIsolated{self?.publish()}};publish()
    }
    @objc func increment(){counter+=1;publish()}
    func publish(){guard let w=window else{return};let state:[String:Any]=["pid":ProcessInfo.processInfo.processIdentifier,"title":title,"counter":counter,"active":NSApplication.shared.isActive,"key_window":w.isKeyWindow,"value":field?.stringValue ?? "","scroll_y":scroll?.contentView.bounds.origin.y ?? 0];if let data=try? JSONSerialization.data(withJSONObject:state){try? data.write(to:URL(fileURLWithPath:folder+"/"+title+".json"),options:.atomic)}}
    func applicationWillTerminate(_ notification:Notification){timer?.invalidate()}
}
@main @MainActor struct NativeFixture {static func main(){let app=NSApplication.shared,fixture=Fixture();app.setActivationPolicy(.regular);app.delegate=fixture;withExtendedLifetime(fixture){app.run()}}}
