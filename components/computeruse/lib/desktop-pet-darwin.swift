import Foundation
import AppKit
import CoreGraphics
import Darwin

@MainActor final class PetImage:NSView {
    var image:NSImage?;var outlined=false;var phase=false;var clicked:((Int)->Void)?,dragged:(()->Void)?,menuRequested:((NSEvent)->Void)?
    override var acceptsFirstResponder:Bool{false}
    override func draw(_ dirtyRect:NSRect){image?.draw(in:bounds.insetBy(dx:6,dy:6));if outlined{(phase ? NSColor.white:NSColor.black).setStroke();let line=NSBezierPath(roundedRect:bounds.insetBy(dx:3,dy:3),xRadius:12,yRadius:12);line.lineWidth=2;line.stroke()}}
    override func mouseDown(with event:NSEvent){clicked?(event.clickCount)}
    override func mouseDragged(with event:NSEvent){dragged?();window?.performDrag(with:event)}
    override func rightMouseDown(with event:NSEvent){menuRequested?(event)}
}
@MainActor final class PreviewWindow:NSWindow {var closed:()->Void = {};override func cancelOperation(_ sender:Any?){closed()}}
@MainActor final class PetHost:NSObject,NSApplicationDelegate {
    var config:[String:Any]=[:],mode:[String:Any]=[:],directory="",owner:pid_t=0,panel:NSPanel?,preview:PreviewWindow?,imageView:PetImage?,previewImage:NSImageView?,previewLabel:NSTextField?,bubble:NSPanel?,lastNotice="",timer:Timer?,pendingClick:DispatchWorkItem?,started=Date(),previewVersion=""
    func read(_ name:String)->[String:Any]{guard let data=try? Data(contentsOf:URL(fileURLWithPath:directory+"/"+name)),let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{return[:]};return value}
    func write(_ name:String,_ value:[String:Any]){if let data=try? JSONSerialization.data(withJSONObject:value){try? data.write(to:URL(fileURLWithPath:directory+"/"+name),options:.atomic)}}
    func applicationDidFinishLaunching(_ notification:Notification){
        guard CommandLine.arguments.count==2,let data=try? Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])),let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let dir=value["directory"] as? String,let pid=value["ownerPid"] as? Int,let asset=value["asset"] as? String,let image=NSImage(contentsOfFile:asset),let screen=NSScreen.main else{NSApplication.shared.terminate(nil);return}
        config=value;directory=dir;owner=pid_t(pid)
        let rect=NSRect(x:screen.visibleFrame.maxX-112,y:screen.visibleFrame.minY+28,width:88,height:88),pet=NSPanel(contentRect:rect,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        pet.isOpaque=false;pet.backgroundColor = .clear;pet.hasShadow=false;pet.level = .floating;pet.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];pet.isReleasedWhenClosed=false
        let view=PetImage(frame:NSRect(origin:.zero,size:rect.size));view.image=image;view.clicked={[weak self] clicks in self?.click(clicks)};view.dragged={[weak self] in self?.pendingClick?.cancel()};view.menuRequested={[weak self] event in self?.configurationMenu(event)};pet.contentView=view;panel=pet;imageView=view;pet.orderFrontRegardless()
        timer=Timer.scheduledTimer(withTimeInterval:0.2,repeats:true){[weak self] _ in MainActor.assumeIsolated{self?.tick()}};tick()
    }
    func click(_ count:Int){
        pendingClick?.cancel();if count>=2{closePreview();openChat();return}
        let click=DispatchWorkItem{[weak self] in MainActor.assumeIsolated{guard let self=self else{return};if self.mode["cu"] as? Bool==true && self.mode["cuMode"] as? String=="virtual" {self.preview==nil ? self.openPreview():self.closePreview()}else{self.openChat()}}};pendingClick=click;DispatchQueue.main.asyncAfter(deadline:.now()+NSEvent.doubleClickInterval,execute:click)
    }
    func openChat(_ page:String="chat"){
        write("open-chat.json",["id":UUID().uuidString,"at":ISO8601DateFormatter().string(from:Date()),"page":page])
        guard let executable=mode["dshExe"] as? String,!executable.isEmpty,let range=executable.range(of:".app/") else{return};let appPath=String(executable[..<range.lowerBound])+".app",options=NSWorkspace.OpenConfiguration();options.activates=true;options.createsNewApplicationInstance=false
        NSWorkspace.shared.openApplication(at:URL(fileURLWithPath:appPath),configuration:options){_,_ in}
    }
    func openPreview(){
        guard let pet=panel else{return};let screen=NSScreen.screens.first(where:{$0.frame.intersects(pet.frame)}) ?? NSScreen.main;guard let screen=screen else{return}
        let window=PreviewWindow(contentRect:screen.visibleFrame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.setFrame(screen.visibleFrame,display:true);window.title="NewMate · Space 只读预览";window.isReleasedWhenClosed=false;window.level = .normal;window.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];window.closed={[weak self] in self?.closePreview()}
        let root=NSView(frame:NSRect(origin:.zero,size:screen.visibleFrame.size)),image=NSImageView(frame:root.bounds);image.imageScaling = .scaleProportionallyUpOrDown;image.autoresizingMask=[.width,.height];root.addSubview(image)
        let label=NSTextField(labelWithString:"等待目标窗口画面；预览不转发输入");label.frame=NSRect(x:16,y:16,width:root.bounds.width-32,height:44);label.autoresizingMask=[.width];root.addSubview(label);window.contentView=root;preview=window;previewImage=image;previewLabel=label;window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps:true);write("preview-request.json",["id":UUID().uuidString,"at":ISO8601DateFormatter().string(from:Date())]);refreshPreview()
    }
    func closePreview(){preview?.orderOut(nil);preview=nil;previewImage=nil;previewLabel=nil;previewVersion=""}
    func refreshPreview(){guard preview?.isVisible==true else{closePreview();return};let state=mode["spacePreview"] as? [String:Any] ?? [:],path=state["imagePath"] as? String ?? "",stamp=state["at"] as? Double ?? 0,age=Date().timeIntervalSince1970*1000-stamp
        if age<3000 && !path.isEmpty {if path != previewVersion{previewImage?.image=NSImage(contentsOfFile:path);previewVersion=path};previewLabel?.stringValue="只读 Space 窗口 · Escape 或再次点击桌宠收起"}
        else {previewImage?.image=nil;previewVersion="";previewLabel?.stringValue=state["error"] as? String ?? "等待新的窗口画面；需要屏幕录制权限。预览不转发输入"}
    }
    func showBubble(_ text:String){bubble?.orderOut(nil);guard let pet=panel else{return};let dark=mode["bubbleDark"] as? Bool ?? true,screen=NSScreen.screens.first(where:{$0.frame.intersects(pet.frame)}) ?? NSScreen.main,visible=screen?.visibleFrame ?? pet.frame,bubbleRect=NSRect(x:min(max(pet.frame.midX-150,visible.minX+8),visible.maxX-308),y:min(max(pet.frame.maxY+10,visible.minY+8),visible.maxY-88),width:300,height:80),window=NSPanel(contentRect:bubbleRect,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false);window.level = .floating;window.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];window.backgroundColor=dark ? .windowBackgroundColor:.white;window.appearance=NSAppearance(named:dark ? .darkAqua:.aqua);window.hasShadow=true
        let button=NSButton(title:text,target:self,action:#selector(bubbleClick));button.frame=NSRect(x:10,y:8,width:280,height:64);button.isBordered=false;button.lineBreakMode = .byWordWrapping;button.font = .systemFont(ofSize:13);window.contentView=button;bubble=window;window.orderFrontRegardless()
    }
    @objc func bubbleClick(){bubble?.orderOut(nil);bubble=nil;openChat()}
    func configurationMenu(_ event:NSEvent){pendingClick?.cancel();guard let view=imageView else{return};let menu=NSMenu(),quit=NSMenuItem(title:"退出陪伴",action:#selector(stopCompanion),keyEquivalent:""),settings=NSMenuItem(title:"打开设置",action:#selector(openSettings),keyEquivalent:"");quit.target=self;settings.target=self;quit.isEnabled=mode["companion"] as? Bool==true;menu.autoenablesItems=false;menu.addItem(quit);menu.addItem(settings);NSMenu.popUpContextMenu(menu,with:event,for:view)}
    @objc func stopCompanion(){write("companion-command.json",["id":UUID().uuidString,"action":"stop-companion"])}
    @objc func openSettings(){openChat("settings")}
    func tick(){
        if kill(owner,0) != 0 || FileManager.default.fileExists(atPath:directory+"/stop"){NSApplication.shared.terminate(nil);return}
        mode=read("mode.json");NSApplication.shared.appearance=NSAppearance(named:mode["bubbleDark"] as? Bool==false ? .aqua:.darkAqua);if mode["cu"] as? Bool != true{closePreview()};if mode["companion"] as? Bool != true{bubble?.orderOut(nil);bubble=nil};let reader=(mode["readerUntil"] as? Double ?? 0)>Date().timeIntervalSince1970*1000
        imageView?.outlined=mode["cu"] as? Bool==true && preview==nil;imageView?.phase=Int(Date().timeIntervalSince(started)*2)%2==0;imageView?.needsDisplay=true
        if preview != nil{refreshPreview()}
        if mode["companion"] as? Bool==true,let data=try? Data(contentsOf:URL(fileURLWithPath:directory+"/notifications.json")),let notices=try? JSONSerialization.jsonObject(with:data) as? [[String:Any]],let notice=notices.last,let id=notice["id"] as? String,id != lastNotice {lastNotice=id;if !reader,let text=notice["bubble"] as? String{showBubble(text)}}
        if reader{bubble?.orderOut(nil);bubble=nil}
        if let bubble=bubble{let dark=mode["bubbleDark"] as? Bool ?? true;bubble.appearance=NSAppearance(named:dark ? .darkAqua:.aqua);bubble.backgroundColor=dark ? .windowBackgroundColor:.white}
        let rect=panel?.frame ?? .zero,idle=CGEventSource.secondsSinceLastEventType(.hidSystemState,eventType:.mouseMoved),keyIdle=CGEventSource.secondsSinceLastEventType(.hidSystemState,eventType:.keyDown)
        let session=CGSessionCopyCurrentDictionary() as? [String:Any],active=session?[kCGSessionOnConsoleKey as String] as? Bool==true && NSWorkspace.shared.frontmostApplication?.bundleIdentifier != "com.apple.loginwindow",idleMs=min(idle,keyIdle)*1000
        write("status.json",["pid":ProcessInfo.processInfo.processIdentifier,"utc":ISO8601DateFormatter().string(from:Date()),"bounds":["x":rect.minX,"y":rect.minY,"width":rect.width,"height":rect.height],"companion":mode["companion"] as? Bool ?? false,"cu":mode["cu"] as? Bool ?? false,"outline_active":imageView?.outlined ?? false,"viewer_expanded":preview != nil,"input_forwarding":false,"reader_focused":reader,"input_idle_ms":idleMs.isFinite ? min(idleMs,86400000):0,"user_desktop_active":active,"bubble_visible":bubble != nil,"bubble_dark":mode["bubbleDark"] as? Bool ?? true,"notification_last_id":lastNotice,"notification_count":0])
    }
    func applicationWillTerminate(_ notification:Notification){timer?.invalidate();pendingClick?.cancel();closePreview();bubble?.orderOut(nil);panel?.orderOut(nil)}
}
@main @MainActor struct MacPet {static func main(){let app=NSApplication.shared,host=PetHost();app.setActivationPolicy(.accessory);app.delegate=host;withExtendedLifetime(host){app.run()}}}
