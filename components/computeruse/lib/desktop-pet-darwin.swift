import Foundation
import AppKit
import CoreGraphics
import Darwin

func croppedPetSprite(_ image:NSImage)->NSImage?{
    guard let cg=image.cgImage(forProposedRect:nil,context:nil,hints:nil)else{return nil};let rep=NSBitmapImageRep(cgImage:cg)
    guard rep.bitsPerSample==8,!rep.isPlanar,rep.samplesPerPixel==4,let pixels=rep.bitmapData else{return nil}
    let alpha=rep.bitmapFormat.contains(.alphaFirst) ? 0:3;var left=cg.width,top=cg.height,right=0,bottom=0
    for y in 0..<cg.height{for x in 0..<cg.width{if pixels[y*rep.bytesPerRow+x*4+alpha]>8{left=min(left,x);top=min(top,y);right=max(right,x);bottom=max(bottom,y)}}}
    guard left<=right,top<=bottom,let cropped=cg.cropping(to:CGRect(x:left,y:top,width:right-left+1,height:bottom-top+1))else{return nil}
    return NSImage(cgImage:cropped,size:NSSize(width:cropped.width,height:cropped.height))
}
func petLayout(_ image:NSImage,multiplier:Double)->(NSSize,NSRect){let width=max(24,(120*multiplier).rounded()),height=floor(image.size.height*width/image.size.width),margin=4.0,padding=ceil(max(width+2*margin,height+2*margin)*0.16);return(NSSize(width:width+2*margin+2*padding,height:height+2*margin+2*padding),NSRect(x:padding+margin,y:padding+margin,width:width,height:height))}
@MainActor final class PetImage:NSView {
    var image:NSImage?;var spriteRect=NSRect.zero;var outlined=false;var phase=0.0;var clicked:((Int)->Void)?,dragged:(()->Void)?,menuRequested:((NSEvent)->Void)?
    private var contourSize=NSSize.zero,contourRect=NSRect.zero,contourScale=0.0,contourPixels=[UInt8](),contourIndices=[Int](),contourAngles=[Double](),pixelWidth=0,pixelHeight=0
    var renderedFrames=0
    func imageRect()->NSRect{if spriteRect != .zero{return spriteRect};guard let image=image else{return .zero};let available=bounds.insetBy(dx:6,dy:6),scale=min(available.width/image.size.width,available.height/image.size.height),size=NSSize(width:image.size.width*scale,height:image.size.height*scale);return NSRect(x:bounds.midX-size.width/2,y:bounds.midY-size.height/2,width:size.width,height:size.height)}
    func contourImage()->CGImage?{
        let scale=window?.backingScaleFactor ?? 1,rect=imageRect()
        if contourSize != bounds.size || contourScale != scale || contourRect != rect {
            contourSize=bounds.size;contourScale=scale;contourRect=rect;pixelWidth=max(1,Int(bounds.width*scale));pixelHeight=max(1,Int(bounds.height*scale));contourIndices=[];contourAngles=[]
            var sprite=[UInt8](repeating:0,count:pixelWidth*pixelHeight*4)
            guard let image=image?.cgImage(forProposedRect:nil,context:nil,hints:nil),let context=CGContext(data:&sprite,width:pixelWidth,height:pixelHeight,bitsPerComponent:8,bytesPerRow:pixelWidth*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)else{return nil}
            context.interpolationQuality = .high;context.draw(image,in:CGRect(x:rect.minX*scale,y:rect.minY*scale,width:rect.width*scale,height:rect.height*scale))
            contourPixels=[UInt8](repeating:0,count:sprite.count);let radius=max(1,Int(2*scale))
            for y in 0..<pixelHeight{for x in 0..<pixelWidth{let i=(y*pixelWidth+x)*4;guard sprite[i+3]<128 else{continue};var edge=false
                for dy in -radius...radius{for dx in -radius...radius where dx*dx+dy*dy<=radius*radius{let px=x+dx,py=y+dy;if px>=0 && py>=0 && px<pixelWidth && py<pixelHeight && sprite[(py*pixelWidth+px)*4+3]>=128{edge=true;break}};if edge{break}}
                if edge{contourIndices.append(i);contourAngles.append(atan2(Double(y)-Double(pixelHeight)/2,Double(x)-Double(pixelWidth)/2))}
            }}
        }
        for (n,i) in contourIndices.enumerated(){let value=UInt8(max(0,min(255,(127.5*(1-cos(2*contourAngles[n]-phase))).rounded())));contourPixels[i]=value;contourPixels[i+1]=value;contourPixels[i+2]=value;contourPixels[i+3]=255}
        guard let provider=CGDataProvider(data:Data(contourPixels) as CFData)else{return nil}
        return CGImage(width:pixelWidth,height:pixelHeight,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:pixelWidth*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGBitmapInfo(rawValue:CGImageAlphaInfo.premultipliedLast.rawValue),provider:provider,decode:nil,shouldInterpolate:false,intent:.defaultIntent)
    }
    override var acceptsFirstResponder:Bool{false}
    override func draw(_ dirtyRect:NSRect){NSGraphicsContext.current?.imageInterpolation = .high;image?.draw(in:imageRect());if outlined,let contour=contourImage(){NSGraphicsContext.current?.cgContext.draw(contour,in:bounds)};renderedFrames+=1}
    override func mouseDown(with event:NSEvent){clicked?(event.clickCount)}
    override func mouseDragged(with event:NSEvent){dragged?();window?.performDrag(with:event)}
    override func rightMouseDown(with event:NSEvent){menuRequested?(event)}
}
@MainActor final class PreviewWindow:NSWindow {var closed:()->Void = {};override func cancelOperation(_ sender:Any?){closed()}}
@MainActor final class PetHost:NSObject,NSApplicationDelegate {
    var config:[String:Any]=[:],mode:[String:Any]=[:],directory="",owner:pid_t=0,panel:NSPanel?,preview:PreviewWindow?,imageView:PetImage?,previewImage:NSImageView?,previewLabel:NSTextField?,bubble:NSPanel?,lastNotice="",timer:Timer?,animationTimer:Timer?,pendingClick:DispatchWorkItem?,started=ProcessInfo.processInfo.systemUptime,previewVersion="",sizeMultiplier=1.0
    func read(_ name:String)->[String:Any]{guard let data=try? Data(contentsOf:URL(fileURLWithPath:directory+"/"+name)),let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{return[:]};return value}
    func write(_ name:String,_ value:[String:Any]){if let data=try? JSONSerialization.data(withJSONObject:value){try? data.write(to:URL(fileURLWithPath:directory+"/"+name),options:.atomic)}}
    func applicationDidFinishLaunching(_ notification:Notification){
        guard CommandLine.arguments.count==2,let data=try? Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])),let value=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let dir=value["directory"] as? String,let pid=value["ownerPid"] as? Int,let asset=value["asset"] as? String,let original=NSImage(contentsOfFile:asset),let image=croppedPetSprite(original),let screen=NSScreen.main else{NSApplication.shared.terminate(nil);return}
        config=value;directory=dir;owner=pid_t(pid)
        sizeMultiplier=readSize();let (size,sprite)=petLayout(image,multiplier:sizeMultiplier)
        let rect=NSRect(x:screen.visibleFrame.maxX-size.width-24,y:screen.visibleFrame.minY+24,width:size.width,height:size.height),pet=NSPanel(contentRect:rect,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        pet.isOpaque=false;pet.backgroundColor = .clear;pet.hasShadow=false;pet.level = .floating;pet.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];pet.isReleasedWhenClosed=false
        let view=PetImage(frame:NSRect(origin:.zero,size:rect.size));view.image=image;view.spriteRect=sprite;view.clicked={[weak self] clicks in self?.click(clicks)};view.dragged={[weak self] in self?.pendingClick?.cancel()};view.menuRequested={[weak self] event in self?.configurationMenu(event)};pet.contentView=view;panel=pet;imageView=view;pet.orderFrontRegardless()
        timer=Timer(timeInterval:0.2,repeats:true){[weak self] _ in MainActor.assumeIsolated{self?.tick()}};RunLoop.main.add(timer!,forMode:.common);animationTimer=Timer(timeInterval:1.0/30,repeats:true){[weak self] _ in MainActor.assumeIsolated{guard let self=self,let view=self.imageView,view.outlined else{return};view.phase=4*Double.pi*(ProcessInfo.processInfo.systemUptime-self.started)/3;view.needsDisplay=true}};RunLoop.main.add(animationTimer!,forMode:.common);tick()
    }
    func readSize()->Double{guard let file=config["settingsPath"] as? String,let bytes=try? Data(contentsOf:URL(fileURLWithPath:file)),let preferences=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any],let value=preferences["size_multiplier"] as? Double,value.isFinite else{return sizeMultiplier};return max(0.3,min(3,value))}
    func refreshSize(){let value=readSize();guard value != sizeMultiplier,let view=imageView,let image=view.image,let panel=panel else{return};sizeMultiplier=value;let (size,sprite)=petLayout(image,multiplier:value),old=panel.frame;panel.setFrame(NSRect(x:old.midX-size.width/2,y:old.minY,width:size.width,height:size.height),display:true);view.frame=NSRect(origin:.zero,size:size);view.spriteRect=sprite;view.needsDisplay=true}
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
        refreshSize();mode=read("mode.json");NSApplication.shared.appearance=NSAppearance(named:mode["bubbleDark"] as? Bool==false ? .aqua:.darkAqua);if mode["cu"] as? Bool != true{closePreview()};if mode["companion"] as? Bool != true{bubble?.orderOut(nil);bubble=nil};let reader=(mode["readerUntil"] as? Double ?? 0)>Date().timeIntervalSince1970*1000
        let outlined=mode["cu"] as? Bool==true && preview==nil;if imageView?.outlined != outlined{imageView?.outlined=outlined;imageView?.needsDisplay=true}
        if preview != nil{refreshPreview()}
        if mode["companion"] as? Bool==true,let data=try? Data(contentsOf:URL(fileURLWithPath:directory+"/notifications.json")),let notices=try? JSONSerialization.jsonObject(with:data) as? [[String:Any]],let notice=notices.last,let id=notice["id"] as? String,id != lastNotice {lastNotice=id;if !reader,let text=notice["bubble"] as? String{showBubble(text)}}
        if reader{bubble?.orderOut(nil);bubble=nil}
        if let bubble=bubble{let dark=mode["bubbleDark"] as? Bool ?? true;bubble.appearance=NSAppearance(named:dark ? .darkAqua:.aqua);bubble.backgroundColor=dark ? .windowBackgroundColor:.white}
        let rect=panel?.frame ?? .zero,idle=CGEventSource.secondsSinceLastEventType(.hidSystemState,eventType:.mouseMoved),keyIdle=CGEventSource.secondsSinceLastEventType(.hidSystemState,eventType:.keyDown)
        let session=CGSessionCopyCurrentDictionary() as? [String:Any],active=session?[kCGSessionOnConsoleKey as String] as? Bool==true && NSWorkspace.shared.frontmostApplication?.bundleIdentifier != "com.apple.loginwindow",idleMs=min(idle,keyIdle)*1000
        write("status.json",["pid":ProcessInfo.processInfo.processIdentifier,"utc":ISO8601DateFormatter().string(from:Date()),"bounds":["x":rect.minX,"y":rect.minY,"width":rect.width,"height":rect.height],"companion":mode["companion"] as? Bool ?? false,"cu":mode["cu"] as? Bool ?? false,"outline_active":imageView?.outlined ?? false,"size_multiplier":sizeMultiplier,"paint_bounds":["x":imageView?.spriteRect.minX ?? 0,"y":imageView?.spriteRect.minY ?? 0,"width":imageView?.spriteRect.width ?? 0,"height":imageView?.spriteRect.height ?? 0],"outline_renderer":"alpha-contour-wave","outline_cycle_ms":3000,"outline_rendered_frames":imageView?.renderedFrames ?? 0,"viewer_expanded":preview != nil,"input_forwarding":false,"reader_focused":reader,"input_idle_ms":idleMs.isFinite ? min(idleMs,86400000):0,"user_desktop_active":active,"bubble_visible":bubble != nil,"bubble_dark":mode["bubbleDark"] as? Bool ?? true,"notification_last_id":lastNotice,"notification_count":0])
    }
    func applicationWillTerminate(_ notification:Notification){timer?.invalidate();animationTimer?.invalidate();pendingClick?.cancel();closePreview();bubble?.orderOut(nil);panel?.orderOut(nil)}
}
@main @MainActor struct MacPet {static func main(){let app=NSApplication.shared,host=PetHost();app.setActivationPolicy(.accessory);app.delegate=host;withExtendedLifetime(host){app.run()}}}
