import SwiftUI
import UIKit
import WebKit

@main
struct CineVaultApp: App {
    @UIApplicationDelegateAdaptor(CineVaultAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

final class CineVaultAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        #if DEBUG
        DebugRotation.install()
        #endif
        PlayerAdBlocker.prepare()
        return true
    }

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        OrientationPolicy.mask
    }

    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == "com.cinevault.ios.downloads" else {
            completionHandler()
            return
        }
        DownloadManager.shared.backgroundEventsCompletionHandler = completionHandler
        DownloadManager.shared.reconnectBackgroundSession()
    }
}

#if DEBUG
/// The Simulator cannot be rotated from the command line, so debug builds turn
/// the interface on a Darwin notification, the way rotating the phone would:
/// `xcrun simctl spawn booted notifyutil -p com.cinevault.debug.landscape` (or `.portrait`).
private enum DebugRotation {
    static func install() {
        for name in ["com.cinevault.debug.landscape", "com.cinevault.debug.portrait"] {
            CFNotificationCenterAddObserver(
                CFNotificationCenterGetDarwinNotifyCenter(), nil,
                { _, _, name, _, _ in
                    let landscape = (name?.rawValue as String?) == "com.cinevault.debug.landscape"
                    Task { @MainActor in
                        OrientationPolicy.rotate(to: landscape ? .landscapeRight : .portrait)
                    }
                },
                name as CFString, nil, .deliverImmediately
            )
        }
    }
}
#endif
