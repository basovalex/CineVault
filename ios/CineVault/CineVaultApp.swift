import SwiftUI
import UIKit

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
