import ImageIO
@MainActor final class ScaleProbeWindow:NSWindow {
    var probeScale:CGFloat=1
    override var backingScaleFactor:CGFloat{probeScale}
}
@main @MainActor struct BorderScaleProbe {
    static func main()throws{
        NSApplication.shared.setActivationPolicy(.prohibited)
        guard let original=NSImage(contentsOfFile:CommandLine.arguments[1]),let sprite=croppedPetSprite(original)else{throw NSError(domain:"sprite_unavailable",code:1)}
        let (layout,spriteFrame)=petLayout(sprite,multiplier:1);precondition(spriteFrame.width==120 && spriteFrame.width/spriteFrame.height>1.2)
        var results=[[String:Any]]()
        for scale:CGFloat in [1,2]{
            let window=ScaleProbeWindow(contentRect:NSRect(x:0,y:0,width:layout.width,height:layout.height),styleMask:.borderless,backing:.buffered,defer:false);window.probeScale=scale
            let view=PetImage(frame:NSRect(x:0,y:0,width:88,height:88));view.image=sprite;view.spriteRect=spriteFrame;view.outlined=true;window.contentView=view
            var previous=[UInt8](),changes=[Int](),opaque=0
            for frame in 0..<4{
                view.phase=Double(frame)*Double.pi/2
                guard let image=view.contourImage()else{throw NSError(domain:"contour_unavailable",code:2)}
                precondition(image.width==Int(layout.width*scale) && image.height==Int(layout.height*scale))
                var pixels=[UInt8](repeating:0,count:image.width*image.height*4)
                let context=CGContext(data:&pixels,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
                context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height))
                opaque=stride(from:3,to:pixels.count,by:4).filter{pixels[$0]>0}.count
                precondition(opaque>100 && opaque<image.width*image.height/3)
                for corner in [0,image.width-1,(image.height-1)*image.width,image.width*image.height-1]{precondition(pixels[corner*4+3]==0)}
                if !previous.isEmpty{let changed=stride(from:0,to:pixels.count,by:4).filter{abs(Int(pixels[$0])-Int(previous[$0]))>8}.count;precondition(changed>100);changes.append(changed)}
                previous=pixels
                let file=URL(fileURLWithPath:CommandLine.arguments[2]+"/native-contour-\(Int(scale))x-\(frame).png"),destination=CGImageDestinationCreateWithURL(file as CFURL,"public.png" as CFString,1,nil)!
                CGImageDestinationAddImage(destination,image,nil);precondition(CGImageDestinationFinalize(destination))
            }
            results.append(["backing_scale":Int(scale),"pixel_width":Int(layout.width*scale),"opaque_contour_pixels":opaque,"consecutive_phase_changes":changes,"transparent_corners":true])
            window.orderOut(nil)
        }
        print(String(data:try JSONSerialization.data(withJSONObject:["ok":true,"actual_production_PetImage":true,"offscreen_backing_scale_fixture":true,"physical_retina_display_tested":false,"results":results],options:[.sortedKeys]),encoding:.utf8)!)
    }
}
