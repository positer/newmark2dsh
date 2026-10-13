import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit
import ImageIO
import Darwin

struct CuFailure: Error { let code: String; let message: String }
final class CuBorder: NSView {
    override func draw(_ dirtyRect: NSRect) { NSColor.systemBlue.setStroke(); let line=NSBezierPath(rect:bounds.insetBy(dx:2,dy:2));line.lineWidth=3;line.stroke() }
}
@main @MainActor struct NativeCU {
    static var owner="", lockFD:Int32 = -1
    static var border:NSPanel?
    static func fail(_ code:String,_ text:String)throws -> Never { throw CuFailure(code:code,message:text) }
    static func windows()->[[String:Any]] {
        let rows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
        return rows.filter{($0[kCGWindowLayer as String] as? Int ?? 1)==0}
    }
    static func target(_ request:[String:Any])throws -> [String:Any] {
        let value=(request["windowHandle"] as? String ?? request["appTarget"] as? String ?? "").split(separator:":")
        guard value.count==3,value[0]=="mac",let id=UInt32(value[1]),let pid=Int(value[2]),let row=windows().first(where:{($0[kCGWindowNumber as String] as? UInt32)==id && ($0[kCGWindowOwnerPID as String] as? Int)==pid}) else {try fail("stale_window","Use a fresh mac:<window-id>:<pid> handle from app_list")}
        return row
    }
    static func bounds(_ row:[String:Any])->CGRect { CGRect(dictionaryRepresentation:row[kCGWindowBounds as String] as! CFDictionary) ?? .zero }
    static func permissions()->[String:Bool] { ["accessibility":AXIsProcessTrusted(),"screenRecording":CGPreflightScreenCaptureAccess()] }
    static func release() { border?.orderOut(nil);border=nil;if lockFD >= 0 {flock(lockFD,LOCK_UN);close(lockFD)};lockFD = -1;owner="" }
    static func lease(_ request:[String:Any])throws {
        guard lockFD >= 0,!owner.isEmpty,request["ownerId"] as? String==owner else {try fail("takeover_required","Acquire this caller's native takeover lease first")}
        guard AXIsProcessTrusted() else {try fail("accessibility_permission_required","Grant Accessibility to the stable helper/owning desktop in macOS settings; no permission is requested automatically")}
    }
    static func capture(_ row:[String:Any]?,sparseOnly:Bool=false)async throws->[String:Any] {
        guard CGPreflightScreenCaptureAccess() else {try fail("screen_recording_permission_required","Grant screen recording in macOS settings; no automatic permission request")}
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("newmark2dsh-computer-use",isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let output=directory.appendingPathComponent("mac-"+UUID().uuidString+".png")
        var image:CGImage?
        if #available(macOS 14.0,*) {
            let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
            let filter:SCContentFilter
            if let row=row,let id=row[kCGWindowNumber as String] as? UInt32,let window=content.windows.first(where:{$0.windowID==id}) {filter=SCContentFilter(desktopIndependentWindow:window)}
            else if row==nil,let display=content.displays.first(where:{$0.displayID==CGMainDisplayID()}) {filter=SCContentFilter(display:display,excludingWindows:[])}
            else {try fail("stale_window","Requested capture target disappeared; no screen fallback")}
            let config=SCStreamConfiguration();config.showsCursor=true
            let rect=row.map(bounds) ?? CGDisplayBounds(CGMainDisplayID())
            config.width=max(1,Int(rect.width));config.height=max(1,Int(rect.height))
            image=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
            if !sparseOnly,let image=image {guard let destination=CGImageDestinationCreateWithURL(output as CFURL,"public.png" as CFString,1,nil) else {try fail("capture_failed","Cannot create PNG")};CGImageDestinationAddImage(destination,image,nil);guard CGImageDestinationFinalize(destination) else {try fail("capture_failed","PNG encoding failed")}}
        } else {
            let command=Process();command.executableURL=URL(fileURLWithPath:"/usr/sbin/screencapture")
            command.arguments=["-x","-t","png"]+(row.map{["-l",String($0[kCGWindowNumber as String] as? UInt32 ?? 0)]} ?? [])+[output.path]
            command.standardOutput=FileHandle.nullDevice;command.standardError=FileHandle.nullDevice;try command.run();command.waitUntilExit()
            guard command.terminationStatus==0 else {try fail("capture_failed","Native screencapture failed")}
            image=CGImageSourceCreateWithURL(output as CFURL,nil).flatMap{CGImageSourceCreateImageAtIndex($0,0,nil)}
        }
        guard let image=image else {try fail("capture_failed","Capture returned no image")}
        if !sparseOnly {try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:output.path)}
        let pixels=UnsafeMutablePointer<UInt8>.allocate(capacity:576);defer{pixels.deallocate()};pixels.initialize(repeating:0,count:576)
        guard let context=CGContext(data:pixels,width:32,height:18,bitsPerComponent:8,bytesPerRow:32,space:CGColorSpaceCreateDeviceGray(),bitmapInfo:CGImageAlphaInfo.none.rawValue) else {try fail("capture_failed","Cannot construct sparse digest")}
        context.draw(image,in:CGRect(x:0,y:0,width:32,height:18))
        var answer:[String:Any]=["ok":true,"width":image.width,"height":image.height,"sparse_grid":Array(UnsafeBufferPointer(start:pixels,count:576))];if !sparseOnly {answer["image_path"]=output.path;answer["image_mime"]="image/png"} else if FileManager.default.fileExists(atPath:output.path){try? FileManager.default.removeItem(at:output)};return answer
    }
    static func dispatch(_ request:[String:Any])async throws->[String:Any] {
        let action=request["action"] as? String ?? ""
        if action=="app_list" {return ["ok":true,"permissions":permissions(),"windows":windows().map{row in ["window_handle":"mac:\(row[kCGWindowNumber as String] as? UInt32 ?? 0):\(row[kCGWindowOwnerPID as String] as? Int ?? 0)","title":row[kCGWindowName as String] as? String ?? "","app":row[kCGWindowOwnerName as String] as? String ?? "","bounds":row[kCGWindowBounds as String] ?? [:]]}]}
        if action=="observe" {return try await capture(nil,sparseOnly:request["sparseOnly"] as? Bool ?? false)}
        if action=="app_observe" {return try await capture(try target(request),sparseOnly:request["sparseOnly"] as? Bool ?? false)}
        if action=="takeover_start" {
            guard let next=request["ownerId"] as? String,!next.isEmpty else {try fail("owner_required","DSH caller identity is required")}
            guard #available(macOS 14.0,*) else {try fail("macos_version_unverified","Interactive CU prototype requires macOS 14+; older macOS remains observation-only")}
            guard AXIsProcessTrusted(),CGPreflightScreenCaptureAccess() else {return ["ok":false,"error_code":"macos_permissions_required","permissions":permissions()]}
            guard NSScreen.main != nil else {try fail("desktop_unavailable","No interactive macOS display is available")}
            if lockFD >= 0 {guard next==owner else {try fail("takeover_busy","Another DSH caller owns this helper")};return ["ok":true,"owner_id":owner,"lease_expiry":"none"]}
            let directory=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/Newmark-CU",isDirectory:true)
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let fd=open(directory.appendingPathComponent("takeover.lock").path,O_CREAT|O_RDWR|O_NOFOLLOW,0o600)
            guard fd >= 0 else {try fail("lease_unavailable","Cannot open native lease file")}
            guard flock(fd,LOCK_EX|LOCK_NB)==0 else {close(fd);try fail("takeover_busy","Another native helper owns the kernel lease")}
            lockFD=fd;owner=next
            if let screen=NSScreen.main {let panel=NSPanel(contentRect:screen.frame,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false);panel.isOpaque=false;panel.backgroundColor = .clear;panel.ignoresMouseEvents=true;panel.level = .screenSaver;panel.collectionBehavior=[.canJoinAllSpaces,.stationary];panel.contentView=CuBorder(frame:NSRect(origin:.zero,size:screen.frame.size));panel.orderFrontRegardless();panel.display();border=panel}
            return ["ok":true,"owner_id":owner,"lease_expiry":"none","native_border":border != nil,"user_input_blocked":false,"input_guard":"target focus validation; helper/session-exclusive lease"]
        }
        if action=="takeover_stop" {guard owner.isEmpty || request["ownerId"] as? String==owner else {try fail("owner_mismatch","Cannot release another caller's lease")};release();return ["ok":true]}
        try lease(request)
        if request["dryRun"] as? Bool==true {return ["ok":true,"dry_run":true,"action":action]}
        if action=="app_activate" {let row=try target(request);guard let app=NSRunningApplication(processIdentifier:pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0)),app.activate(options:[.activateIgnoringOtherApps]) else {try fail("activation_failed","Native application did not activate")};return ["ok":true]}
        var point=CGPoint(x:(request["x"] as? NSNumber)?.doubleValue ?? 0,y:(request["y"] as? NSNumber)?.doubleValue ?? 0)
        if action.hasPrefix("app_") {let row=try target(request),pid=row[kCGWindowOwnerPID as String] as? Int ?? 0;guard NSWorkspace.shared.frontmostApplication?.processIdentifier==pid_t(pid) && windows().first?[kCGWindowNumber as String] as? UInt32==row[kCGWindowNumber as String] as? UInt32 else {try fail("focus_changed","Target is not the frontmost window; reacquire observation")};let rect=bounds(row);point.x+=rect.minX;point.y+=rect.minY;if (action=="app_click" || action=="app_scroll") && !rect.contains(point){try fail("outside_target","Click leaves target window")}}
        if action=="click" || action=="app_click" || action=="move" {let right=request["button"] as? String=="right",button:CGMouseButton=right ? .right:.left;let down:CGEventType=action=="move" ? .mouseMoved:(right ? .rightMouseDown:.leftMouseDown);CGEvent(mouseEventSource:nil,mouseType:down,mouseCursorPosition:point,mouseButton:button)?.post(tap:.cghidEventTap);if action != "move" {CGEvent(mouseEventSource:nil,mouseType:right ? .rightMouseUp:.leftMouseUp,mouseCursorPosition:point,mouseButton:button)?.post(tap:.cghidEventTap)};return ["ok":true]}
        if action=="type" || action=="app_type" {let units=Array((request["text"] as? String ?? "").utf16);var offset=0;while offset<units.count {var end=min(units.count,offset+100);if end<units.count && units[end-1]>=0xD800 && units[end-1]<=0xDBFF {end-=1};let part=Array(units[offset..<end]);offset=end;for down in [true,false] {let event=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:down);event?.keyboardSetUnicodeString(stringLength:part.count,unicodeString:part);event?.post(tap:.cghidEventTap)}};return ["ok":true]}
        if action=="scroll" || action=="app_scroll" {let event=CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:Int32(clamping:(request["scrollY"] as? Int ?? 0)),wheel2:Int32(clamping:(request["scrollX"] as? Int ?? 0)),wheel3:0);if action=="app_scroll"{event?.location=point};event?.post(tap:.cghidEventTap);return ["ok":true]}
        if action=="key" || action=="app_key" {let codes:[String:CGKeyCode]=["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"return":36,"enter":36,"l":37,"j":38,"k":40,"n":45,"m":46,"tab":48,"space":49,"backspace":51,"escape":53,"left":123,"right":124,"down":125,"up":126];let parts=(request["key"] as? String ?? "").lowercased().split(separator:"+").map{String($0)};guard let last=parts.last,let code=codes[last] else {try fail("unsupported_key","Key has no supported native mapping")};var flags:CGEventFlags=[];for modifier in parts.dropLast(){switch modifier {case "cmd","command","meta":flags.insert(.maskCommand);case "ctrl","control":flags.insert(.maskControl);case "alt","option":flags.insert(.maskAlternate);case "shift":flags.insert(.maskShift);default:try fail("unsupported_key","Unknown modifier")}};for down in [true,false] {let event=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down);event?.flags=flags;event?.post(tap:.cghidEventTap)};return ["ok":true]}
        try fail("unsupported_action","This native prototype does not implement \(action); no fallback input is sent")
    }
    static func main()async {
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer{release()}
        while let line=readLine() {var answer:[String:Any];var id:Any=0;do {guard line.utf8.count<=64000,let bytes=line.data(using:.utf8),let request=try JSONSerialization.jsonObject(with:bytes) as? [String:Any] else {throw CuFailure(code:"invalid_request",message:"Invalid bounded JSON request")};id=request["requestId"] ?? 0;answer=try await dispatch(request)}catch let failure as CuFailure{answer=["ok":false,"error_code":failure.code,"error":failure.message]}catch{answer=["ok":false,"error_code":"macos_native_failure","error":String(describing:error)]};answer["requestId"]=id;if let data=try? JSONSerialization.data(withJSONObject:answer,options:[.sortedKeys]),let text=String(data:data,encoding:.utf8){print(text);fflush(stdout)}}
    }
}
