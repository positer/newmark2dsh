import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit
import ImageIO
import Darwin

struct CuFailure: Error { let code: String; let message: String }
final class CuBorder: NSView {
    var phase=0.0
    override func draw(_ dirtyRect: NSRect) {
        let w=bounds.width,h=bounds.height,perimeter=max(1,2*w+2*h),thick:CGFloat=2,step:CGFloat=4
        // Same four-stop, 256-brush clockwise marquee as the Windows reference.
        for distance in stride(from:CGFloat(0),to:perimeter,by:step){let segment=min(step,perimeter-distance);var fraction=((distance+segment/2)/perimeter-CGFloat(phase/(2*Double.pi))).truncatingRemainder(dividingBy:1);if fraction<0{fraction+=1};let brush=floor(fraction*256)/256*4,stop=Int(floor(brush)),mix=brush-floor(brush),gray=stop%2==0 ? mix:1-mix
            NSColor(white:(gray*255).rounded()/255,alpha:1).setFill()
            if distance<w{NSRect(x:distance,y:h-thick,width:min(segment,w-distance),height:thick).fill()}
            else if distance<w+h{let y=distance-w;NSRect(x:w-thick,y:h-y-min(segment,h-y),width:thick,height:min(segment,h-y)).fill()}
            else if distance<2*w+h{let x=w-(distance-w-h),width=min(segment,max(1,x));NSRect(x:max(0,x-width),y:0,width:width,height:thick).fill()}
            else{let y=distance-2*w-h;NSRect(x:0,y:y,width:thick,height:min(segment,max(1,h-y))).fill()}
        }
    }
}
@main @MainActor struct NativeCU {
    static var owner="", lockFD:Int32 = -1
    static var borders:[NSPanel]=[],borderTimer:Timer?,screenObserver:NSObjectProtocol?
    static func refreshBorders(){for panel in borders{panel.orderOut(nil)};borders.removeAll();guard lockFD>=0,spaceHandle.isEmpty else{return};for screen in NSScreen.screens{let panel=NSPanel(contentRect:screen.frame,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false);panel.isOpaque=false;panel.backgroundColor = .clear;panel.hasShadow=false;panel.ignoresMouseEvents=true;panel.level = .screenSaver;panel.collectionBehavior=[.canJoinAllSpaces,.stationary,.fullScreenAuxiliary];panel.contentView=CuBorder(frame:NSRect(origin:.zero,size:screen.frame.size));panel.orderFrontRegardless();panel.display();borders.append(panel)}}
    static func startBorders(){refreshBorders();guard spaceHandle.isEmpty else{return};let started=ProcessInfo.processInfo.systemUptime;borderTimer=Timer(timeInterval:1.0/30,repeats:true){_ in MainActor.assumeIsolated{let phase=2*Double.pi*(ProcessInfo.processInfo.systemUptime-started)/3;for panel in borders{if let view=panel.contentView as? CuBorder{view.phase=phase;view.needsDisplay=true}}}};RunLoop.main.add(borderTimer!,forMode:.common);screenObserver=NotificationCenter.default.addObserver(forName:NSApplication.didChangeScreenParametersNotification,object:nil,queue:.main){_ in MainActor.assumeIsolated{refreshBorders()}}}
    static var spaceHandle=""
    static var operationRevision:[UInt32]?
    static let agentSource:CGEventSource? = {let source=CGEventSource(stateID:.privateState);source?.localEventsSuppressionInterval=0;return source}()
    static let inputEvents:[CGEventType]=[.mouseMoved,.leftMouseDown,.leftMouseUp,.rightMouseDown,.rightMouseUp,.otherMouseDown,.otherMouseUp,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged,.scrollWheel,.keyDown,.keyUp,.flagsChanged,.tabletPointer,.tabletProximity]
    // HID counters also include injected CG events. A listen-only tap excludes only our tagged events.
    static let agentEventTag:Int64=0x4E4D4355494E5054
    static var userTap:CFMachPort?,userTapSource:CFRunLoopSource?,userRevision:UInt32=0,lastUserEvent:Double=0,userKeys:Set<Int64>=[],userButtons:Set<Int64>=[]
    static func postAgent(_ event:CGEvent?){event?.setIntegerValueField(.eventSourceUserData,value:agentEventTag);event?.post(tap:.cghidEventTap)}
    static func startUserMonitor()throws{
        if let tap=userTap,CGEvent.tapIsEnabled(tap:tap){return}
        guard CGPreflightListenEventAccess() else{try fail("input_monitoring_permission_required","Input Monitoring is required; no agent input was sent")}
        guard userTap==nil else{try fail("user_input_state_unavailable","User event monitor is disabled; no input was sent")}
        let mask=inputEvents.reduce(CGEventMask(0)){$0 | (CGEventMask(1)<<$1.rawValue)}
        guard let tap=CGEvent.tapCreate(tap:.cghidEventTap,place:.headInsertEventTap,options:.listenOnly,eventsOfInterest:mask,callback:{_,type,event,_ in
            MainActor.assumeIsolated{
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {if let tap=NativeCU.userTap{CGEvent.tapEnable(tap:tap,enable:true)};NativeCU.userRevision &+= 1;NativeCU.lastUserEvent=ProcessInfo.processInfo.systemUptime;return}
                if event.getIntegerValueField(.eventSourceUnixProcessID)==Int64(getpid()) && event.getIntegerValueField(.eventSourceUserData)==NativeCU.agentEventTag{return}
                NativeCU.userRevision &+= 1;NativeCU.lastUserEvent=ProcessInfo.processInfo.systemUptime
                let key=event.getIntegerValueField(.keyboardEventKeycode),button=event.getIntegerValueField(.mouseEventButtonNumber)
                if type == .keyDown{NativeCU.userKeys.insert(key)};if type == .keyUp{NativeCU.userKeys.remove(key)}
                if [.leftMouseDown,.rightMouseDown,.otherMouseDown].contains(type){NativeCU.userButtons.insert(button)}
                if [.leftMouseUp,.rightMouseUp,.otherMouseUp].contains(type){NativeCU.userButtons.remove(button)}
                if type == .flagsChanged {NativeCU.userKeys.subtract([54,55,56,60,58,61,59,62,63]);if event.flags.contains(.maskCommand){NativeCU.userKeys.insert(55)};if event.flags.contains(.maskShift){NativeCU.userKeys.insert(56)};if event.flags.contains(.maskAlternate){NativeCU.userKeys.insert(58)};if event.flags.contains(.maskControl){NativeCU.userKeys.insert(59)};if event.flags.contains(.maskSecondaryFn){NativeCU.userKeys.insert(63)}}
            };return Unmanaged.passUnretained(event)
        },userInfo:nil) else{try fail("user_input_state_unavailable","Cannot create listen-only user event monitor; no input was sent")}
        userTap=tap;userTapSource=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,tap,0);CFRunLoopAddSource(CFRunLoopGetMain(),userTapSource,.commonModes);CGEvent.tapEnable(tap:tap,enable:true)
        lastUserEvent=ProcessInfo.processInfo.systemUptime;userKeys=Set((0..<128).filter{CGEventSource.keyState(.hidSystemState,key:CGKeyCode($0))}.map{Int64($0)});userButtons=Set([CGMouseButton.left,.right,.center].filter{CGEventSource.buttonState(.hidSystemState,button:$0)}.map{Int64($0.rawValue)})
    }
    static func physicalRevision()->[UInt32]{[userRevision]}
    static func physicalIdle()->Double{ProcessInfo.processInfo.systemUptime-lastUserEvent}
    static func physicalHeld()->Bool{!userKeys.isEmpty || !userButtons.isEmpty}
    static func waitForUserIdle()async throws->[UInt32]{
        try startUserMonitor()
        guard CGPreflightListenEventAccess() else{try fail("input_monitoring_permission_required","Input Monitoring is required to yield to user activity; no agent input was sent")}
        let started=ProcessInfo.processInfo.systemUptime
        while true {
            let idle=physicalIdle();guard idle.isFinite,idle>=0 else{try fail("user_input_state_unavailable","Cannot reliably measure user activity; agent input is paused")}
            if idle>=0.1 && !physicalHeld(){return physicalRevision()}
            if ProcessInfo.processInfo.systemUptime-started>=5{try fail("user_input_busy","User input has not been idle for 100ms; action was not sent at this checkpoint")}
            try await Task.sleep(nanoseconds:20_000_000)
        }
    }
    static func inputCheckpoint(_ revision:[UInt32])throws{
        guard CGPreflightListenEventAccess(),userTap.map({CGEvent.tapIsEnabled(tap:$0)})==true,physicalRevision()==revision,physicalIdle()>=0.1,!physicalHeld() else{try fail("user_input_preempted","User activity resumed; stop agent delivery and re-observe before retrying")}
    }
    static func deliveryCheckpoint()throws{guard let revision=operationRevision else{try fail("input_guard_required","No protected input operation is active")};try inputCheckpoint(revision)}
    struct UserContext {let app:NSRunningApplication;let window:AXUIElement;let windowID:UInt32;let mouse:CGPoint;let revision:[UInt32]}
    static func userContext(_ revision:[UInt32])throws->UserContext{
        guard let app=NSWorkspace.shared.frontmostApplication,let mouse=CGEvent(source:nil)?.location,let window=axElement(axAttribute(AXUIElementCreateApplication(app.processIdentifier),kAXFocusedWindowAttribute)) else{try fail("context_snapshot_unavailable","Cannot snapshot exact user focus and cursor; no agent action is sent")}
        guard let frame=axRect(window),let row=windows().first(where:{($0[kCGWindowOwnerPID as String] as? Int)==Int(app.processIdentifier) && abs(bounds($0).minX-frame.minX)<2 && abs(bounds($0).minY-frame.minY)<2 && abs(bounds($0).width-frame.width)<2 && abs(bounds($0).height-frame.height)<2}),let id=row[kCGWindowNumber as String] as? UInt32 else{try fail("context_snapshot_unavailable","Original focused window is not visible in the current Space")}
        return UserContext(app:app,window:window,windowID:id,mouse:mouse,revision:revision)
    }
    static func restoreUserContext(_ saved:UserContext,_ targetPID:pid_t?,forceSpaceRestore:Bool=false)async->[String:Any]{
        if physicalRevision() != saved.revision || physicalHeld(){return["cursor_restored":false,"focus_restored":false,"user_preempted":true,"reason":"new_user_input_preserved"]}
        let current=NSWorkspace.shared.frontmostApplication?.processIdentifier
        if current != saved.app.processIdentifier && current != targetPID {return["cursor_restored":false,"focus_restored":false,"user_preempted":true,"reason":"unexpected_new_focus_preserved"]}
        var focus=false,cursor=false
        if !saved.app.isTerminated {
            let focused=axElement(axAttribute(AXUIElementCreateApplication(saved.app.processIdentifier),kAXFocusedWindowAttribute))
            if !forceSpaceRestore && current==saved.app.processIdentifier && focused.map({CFEqual($0,saved.window)})==true && windows().contains(where:{($0[kCGWindowNumber as String] as? UInt32)==saved.windowID}) {focus=true}
            else if physicalRevision()==saved.revision,saved.app.activate(options:[]) {
                if physicalRevision()==saved.revision {focus=AXUIElementPerformAction(saved.window,kAXRaiseAction as CFString) == .success}
                // Allow the public activation request to settle; stop restoring if user input resumes.
                var stableSince:Double?;for _ in 0..<150 {if physicalRevision() != saved.revision {break};let active=NSWorkspace.shared.frontmostApplication?.processIdentifier==saved.app.processIdentifier,window=axElement(axAttribute(AXUIElementCreateApplication(saved.app.processIdentifier),kAXFocusedWindowAttribute)),visible=windows().contains(where:{($0[kCGWindowNumber as String] as? UInt32)==saved.windowID}),now=ProcessInfo.processInfo.systemUptime;if active && visible && window.map({CFEqual($0,saved.window)})==true {if stableSince==nil{stableSince=now};if now-(stableSince ?? now)>=(forceSpaceRestore ? 0.6:0){focus=true;break}}else{stableSince=nil};focus=false;try? await Task.sleep(nanoseconds:20_000_000)}
            }
        }
        if physicalRevision() != saved.revision || physicalHeld(){return["cursor_restored":false,"focus_restored":focus,"user_preempted":true,"reason":"new_user_input_preserved"]}
        if let point=CGEvent(source:nil)?.location {if abs(point.x-saved.mouse.x)<1 && abs(point.y-saved.mouse.y)<1 {cursor=true}else{cursor=CGWarpMouseCursorPosition(saved.mouse) == .success}}
        return["cursor_restored":cursor,"focus_restored":focus,"user_preempted":false]
    }
    struct AXTarget { let element:AXUIElement; let window:AXUIElement; let pid:pid_t; let handle:String; let owner:String; let at:Date }
    static var axTargets:[String:AXTarget]=[:]
    static var boundAXWindows:[String:AXUIElement]=[:]
    static func axAttribute(_ element:AXUIElement,_ name:String)->CFTypeRef? {
        var value:CFTypeRef?; return AXUIElementCopyAttributeValue(element,name as CFString,&value) == .success ? value:nil
    }
    static func axElement(_ value:CFTypeRef?)->AXUIElement? {
        guard let value=value,CFGetTypeID(value)==AXUIElementGetTypeID() else{return nil};return unsafeBitCast(value,to:AXUIElement.self)
    }
    static func axRect(_ element:AXUIElement)->CGRect? {
        guard let p=axAttribute(element,kAXPositionAttribute),let s=axAttribute(element,kAXSizeAttribute),CFGetTypeID(p)==AXValueGetTypeID(),CFGetTypeID(s)==AXValueGetTypeID() else{return nil}
        let position=unsafeBitCast(p,to:AXValue.self),size=unsafeBitCast(s,to:AXValue.self);var point=CGPoint.zero,extent=CGSize.zero
        guard AXValueGetType(position) == .cgPoint,AXValueGetType(size) == .cgSize,AXValueGetValue(position,.cgPoint,&point),AXValueGetValue(size,.cgSize,&extent) else{return nil};return CGRect(origin:point,size:extent)
    }
    static func axWindow(_ row:[String:Any])throws->AXUIElement {
        guard AXIsProcessTrusted() else{try fail("accessibility_permission_required","Enable Accessibility for the helper/owning desktop in macOS System Settings")}
        let app=AXUIElementCreateApplication(pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0));AXUIElementSetMessagingTimeout(app,0.25)
        let rect=bounds(row),title=row[kCGWindowName as String] as? String ?? "",all=axAttribute(app,kAXWindowsAttribute) as? [AXUIElement] ?? []
        var matches=all.filter{element in guard let frame=axRect(element) else{return false};return abs(frame.minX-rect.minX)<2 && abs(frame.minY-rect.minY)<2 && abs(frame.width-rect.width)<2 && abs(frame.height-rect.height)<2}
        if matches.count>1 && !title.isEmpty {matches=matches.filter{(axAttribute($0,kAXTitleAttribute) as? String)==title}}
        let key="\(row[kCGWindowNumber as String] as? UInt32 ?? 0):\(row[kCGWindowOwnerPID as String] as? Int ?? 0)"
        // Mission Control omits off-Space windows from AXWindows. Retain only a previously
        // uniquely matched reference; revalidate its PID, role and geometry against fresh CG data.
        if matches.isEmpty,let cached=boundAXWindows[key],let frame=axRect(cached) {var pid:pid_t=0;AXUIElementGetPid(cached,&pid);if pid==pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0),(axAttribute(cached,kAXRoleAttribute) as? String)=="AXWindow",abs(frame.minX-rect.minX)<2,abs(frame.minY-rect.minY)<2,abs(frame.width-rect.width)<2,abs(frame.height-rect.height)<2{return cached}}
        guard matches.count==1 else{try fail("accessibility_window_unavailable","No unique AX window matches the fresh bounds (\(matches.count) matches / \(all.count) AX windows); no arbitrary window is selected")};AXUIElementSetMessagingTimeout(matches[0],0.05);boundAXWindows[key]=matches[0];return matches[0]
    }
    static func axActions(_ element:AXUIElement)->[String] {var names:CFArray?;return AXUIElementCopyActionNames(element,&names) == .success ? (names as? [String] ?? []):[]}
    static func axSecure(_ element:AXUIElement)->Bool {(axAttribute(element,kAXRoleAttribute) as? String)=="AXSecureTextField" || (axAttribute(element,kAXSubroleAttribute) as? String)=="AXSecureTextField"}
    static func axInWindow(_ element:AXUIElement,_ window:AXUIElement,_ pid:pid_t)->Bool {
        var actual:pid_t=0;guard AXUIElementGetPid(element,&actual) == .success,actual==pid else{return false}
        return CFEqual(element,window) || axElement(axAttribute(element,kAXWindowAttribute)).map{CFEqual($0,window)}==true
    }
    static func accessibilitySnapshot(_ row:[String:Any],_ request:[String:Any])throws->[String:Any] {
        let window=try axWindow(row),pid=pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0),handle="mac:\(row[kCGWindowNumber as String] as? UInt32 ?? 0):\(pid)",epoch=UUID().uuidString,started=Date();var elements:[[String:Any]]=[],seen:[AXUIElement]=[],truncated=false
        axTargets.removeAll()
        func visit(_ element:AXUIElement,_ depth:Int) {
            if depth>8 || elements.count>=160 || Date().timeIntervalSince(started)>0.25 {truncated=true;return}
            if seen.contains(where:{CFEqual($0,element)}){return};seen.append(element)
            let id="ax:\(epoch):\(elements.count)",secure=axSecure(element);var item:[String:Any]=["target_id":id,"role":axAttribute(element,kAXRoleAttribute) as? String ?? "","depth":depth,"actions":axActions(element),"secure":secure]
            if !secure {for name in [kAXTitleAttribute,kAXDescriptionAttribute] {if let text=axAttribute(element,name) as? String {item[name==kAXTitleAttribute ? "title":"description"]=String(text.prefix(160))}}}
            if let enabled=axAttribute(element,kAXEnabledAttribute) as? Bool {item["enabled"]=enabled}
            if let rect=axRect(element){item["bounds"]=["x":rect.minX,"y":rect.minY,"width":rect.width,"height":rect.height]}
            elements.append(item);axTargets[id]=AXTarget(element:element,window:window,pid:pid,handle:handle,owner:request["ownerId"] as? String ?? "",at:started)
            var childCount:CFIndex=0;guard AXUIElementGetAttributeValueCount(element,kAXChildrenAttribute as CFString,&childCount) == .success else{return};var values:CFArray?
            if childCount>160 {truncated=true};guard AXUIElementCopyAttributeValues(element,kAXChildrenAttribute as CFString,0,min(childCount,160),&values) == .success else{return}
            for child in values as? [AXUIElement] ?? [] {if elements.count>=160 || Date().timeIntervalSince(started)>0.25 {truncated=true;break};visit(child,depth+1)}
        }
        visit(window,0);return["available":true,"window_handle":handle,"elements":elements,"truncated":truncated,"target_lifetime_seconds":30,"values_omitted":true]
    }
    static func observeAccessible(_ row:[String:Any]?,_ request:[String:Any])async throws->[String:Any] {
        if let row=row,request["activateForObservation"] as? Bool==true,request["previewOnly"] as? Bool != true,row[kCGWindowIsOnscreen as String] as? Bool != true {
            try lease(request);guard !spaceHandle.isEmpty,request["windowHandle"] as? String==spaceHandle else{try fail("space_takeover_required","Observation activation requires the bound Space lease")}
            let revision=try await waitForUserIdle(),saved=try userContext(revision),pid=pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0);var answer:[String:Any]
            do{try inputCheckpoint(revision);let window=try axWindow(row);guard let app=NSRunningApplication(processIdentifier:pid),app.activate(options:[]) else{try fail("activation_failed","Cannot activate selected Space for pixels")};try inputCheckpoint(revision);guard AXUIElementPerformAction(window,kAXRaiseAction as CFString) == .success else{try fail("activation_failed","Cannot raise selected observation window")};for _ in 0..<50 {try inputCheckpoint(revision);if windows().contains(where:{($0[kCGWindowNumber as String] as? UInt32)==row[kCGWindowNumber as String] as? UInt32}){break};try await Task.sleep(nanoseconds:20_000_000)};for _ in 0..<30 {try inputCheckpoint(revision);try await Task.sleep(nanoseconds:20_000_000)};answer=try await observeAccessibleBody(try target(request),request)}catch let failure as CuFailure{answer=["ok":false,"error_code":failure.code,"error":failure.message]}catch{answer=["ok":false,"error_code":"space_observation_failed","error":String(describing:error)]}
            let restored=await restoreUserContext(saved,pid,forceSpaceRestore:true);answer["context_restore"]=restored;answer["space_activated_for_observation"]=true
            if restored["user_preempted"] as? Bool != true,(restored["focus_restored"] as? Bool != true || restored["cursor_restored"] as? Bool != true){answer["ok"]=false;answer["error_code"]="context_restore_failed"};return answer
        }
        return try await observeAccessibleBody(row,request)
    }
    static func observeAccessibleBody(_ row:[String:Any]?,_ request:[String:Any])async throws->[String:Any] {
        let channel=request["observationChannel"] as? String ?? "both"
        guard ["both","visual","accessibility"].contains(channel) else{try fail("invalid_observation_channel","Choose both, visual or accessibility")}
        if request["previewOnly"] as? Bool==true || channel=="visual"{var answer=try await capture(row,sparseOnly:request["sparseOnly"] as? Bool ?? false);answer["capture_available"]=true;answer["channels"]=["visual":["available":true,"included":true],"accessibility":["available":AXIsProcessTrusted(),"included":false]];answer["cross_validation_required"]=false;return answer}
        var accessibility:[String:Any]=["available":false,"error_code":"no_frontmost_window"]
        if let row=row {do{accessibility=try accessibilitySnapshot(row,request)}catch let failure as CuFailure{accessibility=["available":false,"error_code":failure.code,"error":failure.message]}catch{accessibility=["available":false,"error_code":"accessibility_failed"]}}
        let visualAvailable=CGPreflightScreenCaptureAccess();var captureAvailable=visualAvailable && channel != "accessibility";var answer:[String:Any]
        if captureAvailable {do {answer=try await capture(request["action"] as? String=="observe" ? nil:row,sparseOnly:request["sparseOnly"] as? Bool ?? false)}catch {guard accessibility["available"] as? Bool==true else{throw error};captureAvailable=false;answer=["ok":true,"observation_route":"accessibility_only","capture_error":"Native pixel capture failed; AX observation retained"]}}
        else {guard accessibility["available"] as? Bool==true else{try fail("macos_permissions_required","Accessibility or Screen Recording permission is needed for observation")};answer=["ok":true,"observation_route":"accessibility_only"]}
        answer["accessibility"]=accessibility;answer["capture_available"]=captureAvailable;answer["channels"]=["visual":["available":visualAvailable,"included":captureAvailable],"accessibility":["available":accessibility["available"] as? Bool ?? false,"included":true]];answer["cross_validation_required"]=false;answer["permissions"]=permissions();return answer
    }
    static func selectedAX(_ row:[String:Any],_ request:[String:Any],_ point:CGPoint?=nil)throws->AXUIElement? {
        let window=try axWindow(row),pid=pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0)
        if let id=request["targetId"] as? String {
            let handle="mac:\(row[kCGWindowNumber as String] as? UInt32 ?? 0):\(pid)"
            guard let stored=axTargets[id],stored.handle==handle,stored.owner==request["ownerId"] as? String,Date().timeIntervalSince(stored.at)<=30,CFEqual(stored.window,window),axInWindow(stored.element,window,pid) else{try fail("stale_accessibility_target","Re-observe this window; AX target belongs to a different owner/window or has expired")};return stored.element
        }
        let app=AXUIElementCreateApplication(pid);var element:AXUIElement?
        if let point=point {guard AXUIElementCopyElementAtPosition(app,Float(point.x),Float(point.y),&element) == .success else{return nil}}
        else {element=axElement(axAttribute(app,kAXFocusedUIElementAttribute))}
        guard let result=element,axInWindow(result,window,pid) else{try fail("accessibility_target_changed","AX target is outside the selected window")};return result
    }
    static func accessibilityInput(_ row:[String:Any],_ request:[String:Any],_ point:CGPoint)throws->[String:Any]? {
        let action=request["action"] as? String ?? "",explicit=request["targetId"] != nil
        guard action=="app_click" || action=="app_type" else {if explicit{try fail("unsupported_accessibility_action","AX target_id supports app_click/app_type only")};return nil}
        var element:AXUIElement?
        do{element=try selectedAX(row,request,action=="app_click" ? point:nil)}catch let failure as CuFailure {if !explicit && failure.code=="accessibility_window_unavailable" {return nil};throw failure}
        guard var selected=element else {if explicit{try fail("stale_accessibility_target","AX target is no longer available")};return nil}
        if axSecure(selected){try fail("secure_input_refused","Secure AX text fields are not read or edited")}
        if action=="app_click" {
            guard (request["button"] as? String ?? "left")=="left",(request["clickCount"] as? Int ?? 1)==1 else {if explicit{try fail("unsupported_accessibility_action","AXPress represents a single primary activation")};return nil}
            for _ in 0..<6 {
                if axActions(selected).contains(kAXPressAction) {
                    if axAttribute(selected,kAXEnabledAttribute) as? Bool==false{try fail("accessibility_disabled","AX control is disabled")}
                    try deliveryCheckpoint();let result=AXUIElementPerformAction(selected,kAXPressAction as CFString);guard result == .success else{try fail("accessibility_action_failed","AXPress failed (\(result.rawValue)); no event retry")};return["ok":true,"input_route":"accessibility","ax_action":"AXPress"]
                }
                if explicit {break};guard let parent=axElement(axAttribute(selected,kAXParentAttribute)),axInWindow(parent,try axWindow(row),pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0)) else{break};selected=parent
            }
        } else {
            let focused=axElement(axAttribute(AXUIElementCreateApplication(pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0)),kAXFocusedUIElementAttribute))
            guard focused.map({CFEqual($0,selected)})==true else{try fail("accessibility_focus_changed","Focus the selected text field before inserting text")}
            var settable:DarwinBoolean=false
            if AXUIElementIsAttributeSettable(selected,kAXSelectedTextAttribute as CFString,&settable) == .success && settable.boolValue {
                try deliveryCheckpoint();let result=AXUIElementSetAttributeValue(selected,kAXSelectedTextAttribute as CFString,(request["text"] as? String ?? "") as CFString);guard result == .success else{try fail("accessibility_action_failed","AX selected-text insertion failed (\(result.rawValue)); no event retry")};return["ok":true,"input_route":"accessibility","ax_action":"AXSelectedText"]
            }
        }
        if explicit {try fail("unsupported_accessibility_action","This observed AX control does not support the requested semantic action")};return nil
    }
    static func fail(_ code:String,_ text:String)throws -> Never { throw CuFailure(code:code,message:text) }
    static func windows(_ all:Bool=false)->[[String:Any]] {
        let rows=CGWindowListCopyWindowInfo(all ? [.optionAll,.excludeDesktopElements]:[.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
        return rows.filter{($0[kCGWindowLayer as String] as? Int ?? 1)==0}
    }
    static func target(_ request:[String:Any])throws -> [String:Any] {
        let value=(request["windowHandle"] as? String ?? request["appTarget"] as? String ?? "").split(separator:":")
        guard value.count==3,value[0]=="mac",let id=UInt32(value[1]),let pid=Int(value[2]),let row=windows(request["spaceMode"] as? Bool==true).first(where:{($0[kCGWindowNumber as String] as? UInt32)==id && ($0[kCGWindowOwnerPID as String] as? Int)==pid}) else {try fail("stale_window","Use a fresh mac:<window-id>:<pid> handle from app_list")}
        return row
    }
    static func bounds(_ row:[String:Any])->CGRect { CGRect(dictionaryRepresentation:row[kCGWindowBounds as String] as! CFDictionary) ?? .zero }
    static func permissions()->[String:Bool] { ["accessibility":AXIsProcessTrusted(),"screenRecording":CGPreflightScreenCaptureAccess(),"inputMonitoring":CGPreflightListenEventAccess()] }
    static func release() { if let tap=userTap{CGEvent.tapEnable(tap:tap,enable:false);CFMachPortInvalidate(tap)};if let source=userTapSource{CFRunLoopRemoveSource(CFRunLoopGetMain(),source,.commonModes)};userTap=nil;userTapSource=nil;userKeys.removeAll();userButtons.removeAll();borderTimer?.invalidate();borderTimer=nil;if let observer=screenObserver{NotificationCenter.default.removeObserver(observer)};screenObserver=nil;for panel in borders{panel.orderOut(nil)};borders.removeAll();axTargets.removeAll();boundAXWindows.removeAll();spaceHandle="";if lockFD >= 0 {flock(lockFD,LOCK_UN);close(lockFD)};lockFD = -1;owner="" }
    static func lease(_ request:[String:Any])throws {
        guard lockFD >= 0,!owner.isEmpty,request["ownerId"] as? String==owner else {try fail("takeover_required","Acquire this caller's native takeover lease first")}
        guard AXIsProcessTrusted() else {try fail("accessibility_permission_required","Grant Accessibility to the requesting helper/owning desktop identified in macOS settings; no permission is requested automatically")}
    }
    static func capture(_ row:[String:Any]?,sparseOnly:Bool=false)async throws->[String:Any] {
        guard CGPreflightScreenCaptureAccess() else {try fail("screen_recording_permission_required","Grant screen recording in macOS settings; no automatic permission request")}
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("newmark2dsh-computer-use",isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let output=directory.appendingPathComponent("mac-"+UUID().uuidString+".png")
        var image:CGImage?
        if #available(macOS 14.0,*) {
            let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:false)
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
    static func dispatch(_ input:[String:Any])async throws->[String:Any] {
        var request=input;let action=request["action"] as? String ?? "",isSpace=request["spaceMode"] as? Bool==true || (!spaceHandle.isEmpty && request["ownerId"] as? String==owner)
        let channel=request["inputChannel"] as? String ?? "auto"
        guard ["auto","visual","accessibility"].contains(channel) else{try fail("invalid_input_channel","Choose auto, visual or accessibility")}
        if channel=="visual",request["targetId"] != nil,request["crossCheck"] as? Bool != true{try fail("ambiguous_visual_target","Use coordinates alone or request optional cross_check explicitly")}
        if request["crossCheck"] as? Bool==true{guard action=="app_click",request["targetId"] is String,request["x"] is NSNumber,request["y"] is NSNumber else{try fail("invalid_cross_check","Optional geometry check requires app_click, fresh target_id and x/y")}}
        if channel=="accessibility",["app_key","app_scroll","key","scroll","move","click","type"].contains(action){try fail("unsupported_accessibility_action","Explicit AX route only supports scoped semantic click/type/activate")}
        if isSpace {request["spaceMode"]=true;if !spaceHandle.isEmpty {let explicit=request["windowHandle"] as? String;guard explicit==nil || explicit==spaceHandle else{try fail("space_target_mismatch","Cannot redirect a held Space lease to another window")};request["windowHandle"]=spaceHandle}}
        let changing=["app_activate","app_click","app_type","app_scroll","app_key","click","move","type","scroll","key"].contains(action)
        if !changing || request["dryRun"] as? Bool==true {return try await dispatchBody(request)}
        try lease(request)
        guard isSpace ? !spaceHandle.isEmpty:spaceHandle.isEmpty else{try fail("space_takeover_required","Input mode does not match the held native lease")}
        if isSpace && !action.hasPrefix("app_"){try fail("unsafe_space_action","Space mode requires scoped app_* actions")}
        let revision=try await waitForUserIdle(),saved=try userContext(revision),pid=(try? target(request)).map{pid_t($0[kCGWindowOwnerPID as String] as? Int ?? 0)}
        let offSpace=isSpace && (try? target(request))?[kCGWindowIsOnscreen as String] as? Bool != true
        var answer:[String:Any]
        operationRevision=revision;defer{operationRevision=nil}
        do {try inputCheckpoint(revision);answer=try await dispatchBody(request)}
        catch let failure as CuFailure {answer=["ok":false,"error_code":failure.code,"error":failure.message,"delivery_state":"unconfirmed; do not automatically replay"]}
        catch {answer=["ok":false,"error_code":"macos_action_failed","error":String(describing:error),"delivery_state":"unconfirmed; do not automatically replay"]}
        if answer["input_route"] as? String=="coregraphics" {try? await Task.sleep(nanoseconds:25_000_000)}
        answer["input_channel"]=channel;answer["cross_check"]=["requested":request["crossCheck"] as? Bool ?? false,"matched":request["crossCheck"] as? Bool==true && answer["ok"] as? Bool==true]
        if offSpace {for _ in 0..<30 {if physicalRevision() != revision{break};try? await Task.sleep(nanoseconds:20_000_000)}}
        let restored=await restoreUserContext(saved,pid,forceSpaceRestore:offSpace);answer["context_restore"]=restored;answer["user_input_guard"]=["idle_ms":100,"user_input_blocked":false]
        if answer["ok"] as? Bool==true,restored["user_preempted"] as? Bool != true,(restored["focus_restored"] as? Bool != true || restored["cursor_restored"] as? Bool != true){answer["ok"]=false;answer["error_code"]="context_restore_failed";answer["action_applied"]=true;answer["error"]="Action completed but exact context restoration failed; do not replay the action"}
        return answer
    }
    static func dispatchBody(_ request:[String:Any])async throws->[String:Any] {
        let action=request["action"] as? String ?? ""
        if action=="app_list" {return ["ok":true,"permissions":permissions(),"windows":windows(true).map{row in ["window_handle":"mac:\(row[kCGWindowNumber as String] as? UInt32 ?? 0):\(row[kCGWindowOwnerPID as String] as? Int ?? 0)","title":row[kCGWindowName as String] as? String ?? "","app":row[kCGWindowOwnerName as String] as? String ?? "","on_screen":row[kCGWindowIsOnscreen as String] as? Bool ?? false,"bounds":row[kCGWindowBounds as String] ?? [:]]}]}
        if action=="observe" {let pid=NSWorkspace.shared.frontmostApplication?.processIdentifier;return try await observeAccessible(windows().first(where:{($0[kCGWindowOwnerPID as String] as? Int)==pid.map{Int($0)}}),request)}
        if action=="app_observe" {return try await observeAccessible(try target(request),request)}
        if action=="takeover_start" {
            guard let next=request["ownerId"] as? String,!next.isEmpty else {try fail("owner_required","DSH caller identity is required")}
            guard #available(macOS 14.0,*) else {try fail("macos_version_unverified","Interactive CU prototype requires macOS 14+; older macOS remains observation-only")}
            guard AXIsProcessTrusted() else {return ["ok":false,"error_code":"accessibility_permission_required","permissions":permissions()]}
            guard NSScreen.main != nil else {try fail("desktop_unavailable","No interactive macOS display is available")}
            let proposed=request["spaceMode"] as? Bool==true ? (request["windowHandle"] as? String ?? ""):""
            if request["spaceMode"] as? Bool==true && proposed.isEmpty {try fail("space_target_required","Select a window already placed in the Agent Space")}
            if lockFD >= 0 {guard next==owner,proposed==spaceHandle else {try fail("takeover_busy","Another route or caller owns this helper")};return ["ok":true,"owner_id":owner,"lease_expiry":"none"]}
            let directory=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/Newmark-CU",isDirectory:true)
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let fd=open(directory.appendingPathComponent("takeover.lock").path,O_CREAT|O_RDWR|O_NOFOLLOW,0o600)
            guard fd >= 0 else {try fail("lease_unavailable","Cannot open native lease file")}
            guard flock(fd,LOCK_EX|LOCK_NB)==0 else {close(fd);try fail("takeover_busy","Another native helper owns the kernel lease")}
            lockFD=fd;owner=next;spaceHandle=proposed
            var bound=false;defer{if !bound{release()}}
            if !proposed.isEmpty {
                let row=try target(request)
                do{_ = try axWindow(row)}catch let failure as CuFailure {
                    guard failure.code=="accessibility_window_unavailable" else{throw failure}
                    // First binding may require the public activation of the selected app's Space.
                    // This is a guarded setup operation and always restores the exact user context.
                    let revision=try await waitForUserIdle(),saved=try userContext(revision),pid=pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0)
                    var bindingFailure:Error?
                    do{try inputCheckpoint(revision);guard let app=NSRunningApplication(processIdentifier:pid),app.activate(options:[]) else{try fail("activation_failed","Cannot initialize AX for the selected Space")};for _ in 0..<50 {try inputCheckpoint(revision);if (try? axWindow(try target(request))) != nil{break};try await Task.sleep(nanoseconds:20_000_000)};_ = try axWindow(try target(request))}catch{bindingFailure=error}
                    for _ in 0..<30 {if physicalRevision() != revision{break};try? await Task.sleep(nanoseconds:20_000_000)}
                    let restored=await restoreUserContext(saved,pid,forceSpaceRestore:true)
                    if let failure=bindingFailure{throw failure}
                    guard restored["focus_restored"] as? Bool==true,restored["cursor_restored"] as? Bool==true,restored["user_preempted"] as? Bool==false else{try fail("space_binding_restore_unconfirmed","Space binding did not restore the original context; re-observe before continuing")}
                }
            }
            bound=true
            startBorders()
            return ["ok":true,"owner_id":owner,"lease_expiry":"none","lease":["owner_id":owner,"mouse_mode":spaceHandle.isEmpty ? "real":"virtual","acquired_at":Date().timeIntervalSince1970*1000],"native_border":!borders.isEmpty,"user_input_blocked":false,"permissions":permissions(),"desktop_backend":spaceHandle.isEmpty ? "native":"mission_control_space","space_window_handle":spaceHandle,"independent_input":false,"input_guard":"100ms physical-user idle; exact context restoration; AX-first scoped targets"]
        }
        if action=="takeover_stop" {guard owner.isEmpty || request["ownerId"] as? String==owner else {try fail("owner_mismatch","Cannot release another caller's lease")};let previous=owner;release();return ["ok":true,"released_owner":previous]}
        try lease(request)
        if request["dryRun"] as? Bool==true {return ["ok":true,"dry_run":true,"action":action]}
        if action=="app_activate" {try deliveryCheckpoint();let row=try target(request),window=try axWindow(row);guard let app=NSRunningApplication(processIdentifier:pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0)),app.activate(options:[]) else {try fail("activation_failed","Native application did not activate")};try deliveryCheckpoint();let raised=AXUIElementPerformAction(window,kAXRaiseAction as CFString);guard raised == .success else{try fail("accessibility_action_failed","AXRaise failed; re-observe the selected window")};return ["ok":true,"input_route":"accessibility","ax_action":"AXRaise"]}
        var point=CGPoint(x:(request["x"] as? NSNumber)?.doubleValue ?? 0,y:(request["y"] as? NSNumber)?.doubleValue ?? 0)
        let visual=request["inputChannel"] as? String=="visual",axOnly=request["inputChannel"] as? String=="accessibility"
        if request["crossCheck"] as? Bool==true {let row=try target(request),rect=bounds(row),absolute=CGPoint(x:rect.minX+point.x,y:rect.minY+point.y);guard let element=try selectedAX(row,request),let frame=axRect(element),frame.contains(absolute) else{try fail("channel_cross_check_mismatch","Point and fresh AX target disagree; neither input route was sent")}}
        if visual && action=="app_click" {guard request["x"] is NSNumber,request["y"] is NSNumber else{try fail("visual_coordinates_required","Visual click requires window-relative x/y")}}
        if request["spaceMode"] as? Bool==true && (["app_key","app_scroll"].contains(action) || visual && ["app_click","app_type"].contains(action)){try deliveryCheckpoint();let row=try target(request),pid=pid_t(row[kCGWindowOwnerPID as String] as? Int ?? 0),window=try axWindow(row);guard let app=NSRunningApplication(processIdentifier:pid),app.activate(options:[]) else{try fail("activation_failed","Cannot activate the bound Space target")};try deliveryCheckpoint();guard AXUIElementPerformAction(window,kAXRaiseAction as CFString) == .success else{try fail("activation_failed","Cannot raise the bound Space target")};let settle=row[kCGWindowIsOnscreen as String] as? Bool==true ? 0.0:0.6;var readySince:Double?;for _ in 0..<100 {try deliveryCheckpoint();let now=ProcessInfo.processInfo.systemUptime;if NSWorkspace.shared.frontmostApplication?.processIdentifier==pid && windows().first?[kCGWindowNumber as String] as? UInt32==row[kCGWindowNumber as String] as? UInt32 {if readySince==nil{readySince=now};if now-(readySince ?? now)>=settle{break}}else{readySince=nil};try await Task.sleep(nanoseconds:20_000_000)};guard let ready=readySince,ProcessInfo.processInfo.systemUptime-ready>=settle else{try fail("space_transition_unconfirmed","Target Space has not settled; no visual event was sent")}}
        if request["spaceMode"] as? Bool==true && !visual && ["app_click","app_type"].contains(action){let row=try target(request),rect=bounds(row);point.x+=rect.minX;point.y+=rect.minY;if action=="app_click" && !rect.contains(point){try fail("outside_target","Click leaves bound Space window")};if let answer=try accessibilityInput(row,request,point){return answer};try fail("space_ax_action_unavailable","This Space control has no supported AX action; choose visual explicitly; no automatic fallback")}
        if action.hasPrefix("app_") {let row=try target(request),pid=row[kCGWindowOwnerPID as String] as? Int ?? 0;guard NSWorkspace.shared.frontmostApplication?.processIdentifier==pid_t(pid) && windows().first?[kCGWindowNumber as String] as? UInt32==row[kCGWindowNumber as String] as? UInt32 else {try fail("focus_changed","Target is not the frontmost window; reacquire observation")};let rect=bounds(row);point.x+=rect.minX;point.y+=rect.minY;if (action=="app_click" || action=="app_scroll") && !rect.contains(point){try fail("outside_target","Click leaves target window")}}
        if !visual {if action.hasPrefix("app_"){if let result=try accessibilityInput(try target(request),request,point){return result}}
        else if action=="click" || action=="type" {let pid=NSWorkspace.shared.frontmostApplication?.processIdentifier;if let row=windows().first(where:{($0[kCGWindowOwnerPID as String] as? Int)==pid.map{Int($0)}}),action=="type" || bounds(row).contains(point) {var scoped=request;scoped["action"]=action=="type" ? "app_type":"app_click";if let result=try accessibilityInput(row,scoped,point){return result}}}
        else if request["targetId"] != nil {try fail("accessibility_window_required","Use AX target_id only with scoped app_click/app_type")}}
        if axOnly {try fail("unsupported_accessibility_action","No supported AX semantic action; visual coordinates remain separately available")}
        if visual && action=="app_type",let element=axElement(axAttribute(AXUIElementCreateApplication(pid_t(try target(request)[kCGWindowOwnerPID as String] as? Int ?? 0)),kAXFocusedUIElementAttribute)),axSecure(element){try fail("secure_input_refused","Secure fields are not typed into through the visual route")}
        if action=="click" || action=="app_click" || action=="move" {try deliveryCheckpoint();let right=request["button"] as? String=="right",button:CGMouseButton=right ? .right:.left;let down:CGEventType=action=="move" ? .mouseMoved:(right ? .rightMouseDown:.leftMouseDown);postAgent(CGEvent(mouseEventSource:agentSource,mouseType:down,mouseCursorPosition:point,mouseButton:button));if action != "move" {postAgent(CGEvent(mouseEventSource:agentSource,mouseType:right ? .rightMouseUp:.leftMouseUp,mouseCursorPosition:point,mouseButton:button))};return ["ok":true,"input_route":"coregraphics"]}
        if action=="type" || action=="app_type" {let units=Array((request["text"] as? String ?? "").utf16);var offset=0;while offset<units.count {try deliveryCheckpoint();var end=min(units.count,offset+100);if end<units.count && units[end-1]>=0xD800 && units[end-1]<=0xDBFF {end-=1};let part=Array(units[offset..<end]);offset=end;for down in [true,false] {let event=CGEvent(keyboardEventSource:agentSource,virtualKey:0,keyDown:down);event?.keyboardSetUnicodeString(stringLength:part.count,unicodeString:part);postAgent(event)}};return ["ok":true,"input_route":"coregraphics"]}
        if action=="scroll" || action=="app_scroll" {try deliveryCheckpoint();let event=CGEvent(scrollWheelEvent2Source:agentSource,units:.pixel,wheelCount:2,wheel1:Int32(clamping:(request["scrollY"] as? Int ?? 0)),wheel2:Int32(clamping:(request["scrollX"] as? Int ?? 0)),wheel3:0);if action=="app_scroll"{postAgent(CGEvent(mouseEventSource:agentSource,mouseType:.mouseMoved,mouseCursorPosition:point,mouseButton:.left));try await Task.sleep(nanoseconds:20_000_000);try deliveryCheckpoint();event?.location=point};postAgent(event);return ["ok":true,"input_route":"coregraphics"]}
        if action=="key" || action=="app_key" {let codes:[String:CGKeyCode]=["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"return":36,"enter":36,"l":37,"j":38,"k":40,"n":45,"m":46,"tab":48,"space":49,"backspace":51,"escape":53,"left":123,"right":124,"down":125,"up":126];let parts=(request["key"] as? String ?? "").lowercased().split(separator:"+").map{String($0)};guard let last=parts.last,let code=codes[last] else {try fail("unsupported_key","Key has no supported native mapping")};var flags:CGEventFlags=[];var modifierCodes:[CGKeyCode]=[];for modifier in parts.dropLast(){switch modifier {case "cmd","command","meta":flags.insert(.maskCommand);modifierCodes.append(55);case "ctrl","control":flags.insert(.maskControl);modifierCodes.append(59);case "alt","option":flags.insert(.maskAlternate);modifierCodes.append(58);case "shift":flags.insert(.maskShift);modifierCodes.append(56);default:try fail("unsupported_key","Unknown modifier")}};try deliveryCheckpoint();for modifier in modifierCodes{let event=CGEvent(keyboardEventSource:agentSource,virtualKey:modifier,keyDown:true);event?.flags=flags;postAgent(event)};for down in [true,false] {let event=CGEvent(keyboardEventSource:agentSource,virtualKey:code,keyDown:down);event?.flags=flags;postAgent(event)};for modifier in modifierCodes.reversed(){let event=CGEvent(keyboardEventSource:agentSource,virtualKey:modifier,keyDown:false);event?.flags=[];postAgent(event)};return ["ok":true,"input_route":"coregraphics"]}
        try fail("unsupported_action","This native prototype does not implement \(action); no fallback input is sent")
    }
    static func nextLine()async->String?{await withCheckedContinuation{continuation in DispatchQueue.global(qos:.utility).async{continuation.resume(returning:readLine())}}}
    static func main(){let app=NSApplication.shared;app.setActivationPolicy(.prohibited);Task{await protocolLoop();app.terminate(nil)};app.run()}
    static func protocolLoop()async {
        NSApplication.shared.setActivationPolicy(.prohibited)
        defer{release()}
        while let line=await nextLine() {var answer:[String:Any];var id:Any=0;do {guard line.utf8.count<=64000,let bytes=line.data(using:.utf8),let request=try JSONSerialization.jsonObject(with:bytes) as? [String:Any] else {throw CuFailure(code:"invalid_request",message:"Invalid bounded JSON request")};id=request["requestId"] ?? 0;answer=try await dispatch(request)}catch let failure as CuFailure{answer=["ok":false,"error_code":failure.code,"error":failure.message]}catch{answer=["ok":false,"error_code":"macos_native_failure","error":String(describing:error)]};answer["requestId"]=id;if let data=try? JSONSerialization.data(withJSONObject:answer,options:[.sortedKeys]),let text=String(data:data,encoding:.utf8){print(text);fflush(stdout)}}
    }
}
