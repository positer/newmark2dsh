// Public AX inspection of Mission Control in a disposable CI desktop; no private Space API.
import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

@main struct SpaceProbe {
    static func attr(_ e:AXUIElement,_ name:String)->CFTypeRef?{var v:CFTypeRef?;return AXUIElementCopyAttributeValue(e,name as CFString,&v) == .success ? v:nil}
    static func main()throws{
        guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"]=="true",let dock=NSRunningApplication.runningApplications(withBundleIdentifier:"com.apple.dock").first else{print("{\"available\":false,\"reason\":\"ci_dock_unavailable\"}");return}
        if CommandLine.arguments.contains("--escape"){for down in [true,false]{CGEvent(keyboardEventSource:CGEventSource(stateID:.privateState),virtualKey:53,keyDown:down)?.post(tap:.cghidEventTap)};return}
        let root=AXUIElementCreateApplication(dock.processIdentifier);AXUIElementSetMessagingTimeout(root,0.1);var rows:[[String:Any]]=[],seen:[AXUIElement]=[],elements:[AXUIElement]=[]
        func visit(_ e:AXUIElement,_ depth:Int,_ spaces:Bool=false){guard depth<16,rows.count<400,!seen.contains(where:{CFEqual($0,e)}) else{return};seen.append(e);let identifier=attr(e,kAXIdentifierAttribute) as? String ?? "",isSpaces=spaces || identifier=="mc.spaces.list";var row:[String:Any]=["role":attr(e,kAXRoleAttribute) as? String ?? "","depth":depth,"space_control":isSpaces];for name in [kAXTitleAttribute,kAXDescriptionAttribute,kAXIdentifierAttribute]{if let text=attr(e,name) as? String{row[name]=String(text.prefix(150))}};rows.append(row);elements.append(e);for child in attr(e,kAXChildrenAttribute) as? [AXUIElement] ?? []{visit(child,depth+1,isSpaces)}}
        visit(root,0);for child in attr(root,kAXWindowsAttribute) as? [AXUIElement] ?? []{visit(child,0)}
        var result:[String:Any]=["available":AXIsProcessTrusted(),"dock_pid":dock.processIdentifier,"elements":rows]
        if CommandLine.arguments.count==3{let selector=CommandLine.arguments[1],value=CommandLine.arguments[2];guard let index=rows.firstIndex(where:{row in row["role"] as? String=="AXButton" && (row["space_control"] as? Bool==true || row[kAXIdentifierAttribute] as? String=="mc.spaces.add") && (selector=="--press-id" ? row[kAXIdentifierAttribute] as? String==value:selector=="--press-title" && row[kAXTitleAttribute] as? String==value)}) else{throw NSError(domain:"space_control_unavailable",code:1)};result["action_code"]=AXUIElementPerformAction(elements[index],kAXPressAction as CFString).rawValue}
        let data=try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!)
    }
}
