// Test utility: accepts only the current test's explicit owned PID allowlist.
import Foundation
import AppKit
import ApplicationServices
import ImageIO
import CoreGraphics

@main struct Driver {
    static func attr(_ e:AXUIElement,_ name:String)->CFTypeRef?{var v:CFTypeRef?;return AXUIElementCopyAttributeValue(e,name as CFString,&v) == .success ? v:nil}
    static func main()throws{
        let input=try JSONSerialization.jsonObject(with:Data(CommandLine.arguments[1].utf8)) as! [String:Any],action=input["action"] as! String
        let allowed=Set((ProcessInfo.processInfo.environment["NEWMARK_OWNED_PIDS"] ?? "").split(separator:",").compactMap{Int($0)})
        var result:[String:Any]=[:]
        if action=="cursor"{let p=CGEvent(source:nil)!.location;result=["x":p.x,"y":p.y]}
        else if action=="image" {
            let url=URL(fileURLWithPath:input["path"] as! String),source=CGImageSourceCreateWithURL(url as CFURL,nil)!,image=CGImageSourceCreateImageAtIndex(source,0,nil)!
            var pixels=[UInt8](repeating:0,count:32*32*4)
            let ctx=CGContext(data:&pixels,width:32,height:32,bitsPerComponent:8,bytesPerRow:128,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.draw(image,in:CGRect(x:0,y:0,width:32,height:32));var colors=Set<Int>();for i in stride(from:0,to:pixels.count,by:4){let red=Int(pixels[i]),green=Int(pixels[i+1]),blue=Int(pixels[i+2]);colors.insert(red*65536+green*256+blue)}
            result=["width":image.width,"height":image.height,"sample_colors":colors.count,"visible_samples":stride(from:3,to:pixels.count,by:4).filter{pixels[$0]>0}.count]
        }else{
            let pid=input["pid"] as! Int;guard allowed.contains(pid) else{throw NSError(domain:"unowned_pid",code:1)}
            let rows=(CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []).filter{($0[kCGWindowOwnerPID as String] as? Int)==pid}
            if action=="windows"{result=["windows":rows.map{["id":$0[kCGWindowNumber as String] ?? 0,"title":$0[kCGWindowName as String] ?? "","bounds":$0[kCGWindowBounds as String] ?? [:],"visible":$0[kCGWindowIsOnscreen as String] ?? false]}]}
            else if action=="activate"{result=["ok":NSRunningApplication(processIdentifier:pid_t(pid))?.activate(options:[]) ?? false]}
            else if action=="escape"{guard NSWorkspace.shared.frontmostApplication?.processIdentifier==pid_t(pid) else{throw NSError(domain:"unfocused_owned_window",code:4)};for down in [true,false]{CGEvent(keyboardEventSource:CGEventSource(stateID:.privateState),virtualKey:53,keyDown:down)?.post(tap:.cghidEventTap)};result=["ok":true]}
            else if action=="click" || action=="hold" {
                let id=input["window"] as! Int;guard let row=rows.first(where:{($0[kCGWindowNumber as String] as? Int)==id}),row[kCGWindowIsOnscreen as String] as? Bool==true,let b=row[kCGWindowBounds as String] as? [String:Any],let rect=CGRect(dictionaryRepresentation:b as CFDictionary) else{throw NSError(domain:"owned_window_unavailable",code:2)}
                let point=CGPoint(x:rect.minX+rect.width*(input["rx"] as? Double ?? 0.5),y:rect.minY+rect.height*(input["ry"] as? Double ?? 0.5));guard rect.contains(point) else{throw NSError(domain:"outside_owned_window",code:3)}
                let source=CGEventSource(stateID:.privateState),right=input["right"] as? Bool==true,count=input["count"] as? Int ?? 1
                for i in 1...count{for down in [true,false]{let e=CGEvent(mouseEventSource:source,mouseType:down ? (right ? .rightMouseDown:.leftMouseDown):(right ? .rightMouseUp:.leftMouseUp),mouseCursorPosition:point,mouseButton:right ? .right:.left)!;e.setIntegerValueField(.mouseEventClickState,value:Int64(i));e.post(tap:.cghidEventTap);if down && action=="hold"{print("HOLD_READY");fflush(stdout);Thread.sleep(forTimeInterval:0.5)}};Thread.sleep(forTimeInterval:0.06)};result=["ok":true,"synthetic_input":true,"target_pid":pid]
            }else if action=="menu"{
                let app=AXUIElementCreateApplication(pid_t(pid));var titles:[String]=[],chosen:AXUIElement?,seen=0
                func visit(_ e:AXUIElement,_ depth:Int){guard depth<10,seen<300 else{return};seen+=1;let title=attr(e,kAXTitleAttribute) as? String ?? "",role=attr(e,kAXRoleAttribute) as? String ?? "";if role=="AXMenuItem"{titles.append(title);if title==input["title"] as? String{chosen=e}};for child in attr(e,kAXChildrenAttribute) as? [AXUIElement] ?? []{visit(child,depth+1)}}
                visit(app,0);for e in attr(app,kAXWindowsAttribute) as? [AXUIElement] ?? []{visit(e,0)}
                let cursor=CGEvent(source:nil)!.location;var hit:AXUIElement?;if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(cursor.x),Float(cursor.y),&hit) == .success,let hit=hit{var actual:pid_t=0;AXUIElementGetPid(hit,&actual);if actual==pid_t(pid){visit(hit,0);if let parent=attr(hit,kAXParentAttribute),CFGetTypeID(parent)==AXUIElementGetTypeID(){visit(unsafeBitCast(parent,to:AXUIElement.self),0)}}}
                var code:Int32 = -1;if let e=chosen{code=AXUIElementPerformAction(e,kAXPressAction as CFString).rawValue};result=["titles":titles,"press_code":code]
            }
        }
        let data=try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!)
    }
}
