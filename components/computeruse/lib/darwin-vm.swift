// Explicitly provisioned isolated Linux guest prototype. Never substitutes macOS Spaces.
import Foundation
import AppKit
import Virtualization

@available(macOS 13.0,*) @MainActor final class GuestWindow:NSObject,NSApplicationDelegate {
    var machine:VZVirtualMachine?
    var window:NSWindow?
    func applicationDidFinishLaunching(_ notification:Notification) {
        do {
            guard CommandLine.arguments.count==2 else {throw NSError(domain:"NewmarkVM",code:1,userInfo:[NSLocalizedDescriptionKey:"Pass an explicit guest-config.json; no images are downloaded or created"])}
            let data=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))
            guard let config=try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw NSError(domain:"NewmarkVM",code:2)}
            func file(_ key:String)throws->URL {guard let value=config[key] as? String,value.hasPrefix("/"),FileManager.default.fileExists(atPath:value) else {throw NSError(domain:"NewmarkVM",code:3,userInfo:[NSLocalizedDescriptionKey:"Missing explicit absolute file: "+key])};return URL(fileURLWithPath:value)}
            let vm=VZVirtualMachineConfiguration()
            let boot=VZLinuxBootLoader(kernelURL:try file("kernel"));boot.initialRamdiskURL=try file("initrd");boot.commandLine=config["bootArgs"] as? String ?? "console=hvc0 root=/dev/vda rw"
            vm.bootLoader=boot;vm.platform=VZGenericPlatformConfiguration()
            vm.cpuCount=min(VZVirtualMachineConfiguration.maximumAllowedCPUCount,max(VZVirtualMachineConfiguration.minimumAllowedCPUCount,config["cpuCount"] as? Int ?? 2))
            let memoryMiB=config["memoryMiB"] as? Int ?? 2048;guard memoryMiB>=512 && memoryMiB<=16384 else {throw NSError(domain:"NewmarkVM",code:4,userInfo:[NSLocalizedDescriptionKey:"memoryMiB must be 512–16384"])}
            vm.memorySize=max(VZVirtualMachineConfiguration.minimumAllowedMemorySize,min(VZVirtualMachineConfiguration.maximumAllowedMemorySize,UInt64(memoryMiB)*1024*1024))
            let disk=VZVirtioBlockDeviceConfiguration(attachment:try VZDiskImageStorageDeviceAttachment(url:try file("disk"),readOnly:false));vm.storageDevices=[disk]
            let graphics=VZVirtioGraphicsDeviceConfiguration();graphics.scanouts=[VZVirtioGraphicsScanoutConfiguration(widthInPixels:1280,heightInPixels:800)];vm.graphicsDevices=[graphics]
            vm.keyboards=[VZUSBKeyboardConfiguration()];vm.pointingDevices=[VZUSBScreenCoordinatePointingDeviceConfiguration()]
            vm.entropyDevices=[VZVirtioEntropyDeviceConfiguration()]
            // No shared Host folders, clipboard or global CGEvents. Networking is opt-in.
            if config["allowNAT"] as? Bool==true {let network=VZVirtioNetworkDeviceConfiguration();network.attachment=VZNATNetworkDeviceAttachment();vm.networkDevices=[network]}
            try vm.validate()
            let machine=VZVirtualMachine(configuration:vm);self.machine=machine
            let view=VZVirtualMachineView(frame:NSRect(x:0,y:0,width:1280,height:800));view.virtualMachine=machine
            let window=NSWindow(contentRect:view.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false);window.title="Newmark · 隔离 Linux VM（原型）";window.contentView=view;self.window=window;window.makeKeyAndOrderFront(nil)
            machine.start {result in if case .failure(let error)=result {fputs("VM start failed: \(error)\n",stderr);NSApplication.shared.terminate(nil)}}
        }catch{fputs("VM provisioning failed: \(error)\n",stderr);NSApplication.shared.terminate(nil)}
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool {true}
    func applicationWillTerminate(_ notification:Notification){try? machine?.requestStop()}
}
@main @MainActor struct NewmarkVM {
    static func main(){if #available(macOS 13.0,*){let app=NSApplication.shared;let delegate=GuestWindow();app.delegate=delegate;app.setActivationPolicy(.regular);withExtendedLifetime(delegate){app.run()}}else{fputs("Isolated guest prototype requires macOS 13+\n",stderr)}}
}
