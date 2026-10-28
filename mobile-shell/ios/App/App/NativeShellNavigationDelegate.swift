import Capacitor
import UIKit
import WebKit

final class NativeShellNavigationDelegate: NSObject, WKNavigationDelegate {
    private let remoteOrigin: String
    private let offlineURL: URL
    private let capacitorDelegate: WebViewDelegationHandler
    private var smokeRan = false

    init(remoteOrigin: String, offlineURL: URL, capacitorDelegate: WebViewDelegationHandler) {
        self.remoteOrigin = remoteOrigin
        self.offlineURL = offlineURL
        self.capacitorDelegate = capacitorDelegate
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if NativeOriginPolicy.isTrustedRemote(url, remoteOrigin: remoteOrigin) || NativeOriginPolicy.isBundledOffline(url) {
            capacitorDelegate.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
            return
        }
        let topLevel = navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true
        if topLevel && NativeOriginPolicy.isApprovedExternal(url) && webView.window?.windowScene?.activationState == .foregroundActive {
            #if DEBUG
            NSLog("NS0_EXTERNAL_HANDOFF scheme=%@ host=%@", url.scheme ?? "", url.host ?? "")
            #endif
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        capacitorDelegate.webView(webView, didStartProvisionalNavigation: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        capacitorDelegate.webView(webView, didFinish: navigation)
        #if DEBUG
        if let url = webView.url, NativeOriginPolicy.isTrustedRemote(url, remoteOrigin: remoteOrigin) {
            let script = "(function(){var n=window.idbotsNative;var p=window.idbotsNativeProof;var f=window.idbotsMobile;return JSON.stringify({origin:location.origin,nativeBridgeVersion:n&&n.nativeBridgeVersion,nativePhase:n&&n.bootstrap&&n.bootstrap.phase,platform:n&&n.bootstrap&&n.bootstrap.platform,proof:p,capabilities:n&&n.getCapabilities(),shell:f&&f.shell,os:f&&f.os});})()"
            webView.evaluateJavaScript(script) { result, _ in
                if let result = result as? String { NSLog("NS0_BOOTSTRAP %@", result) }
            }
            runSmokeIfNeeded(in: webView)
        }
        #endif
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showOffline(for: error, in: webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOffline(for: error, in: webView)
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        capacitorDelegate.webView(webView, didReceive: challenge, completionHandler: completionHandler)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        capacitorDelegate.webViewWebContentProcessDidTerminate(webView)
    }

    private func showOffline(for error: Error, in webView: WKWebView) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if webView.url?.absoluteString == offlineURL.absoluteString { return }
        webView.isOpaque = true
        webView.load(URLRequest(url: offlineURL))
        #if DEBUG
        NSLog("NS0_OFFLINE page=bundled retryOrigin=%@", remoteOrigin)
        if ProcessInfo.processInfo.environment["NS0_SMOKE"] == "offline-retry" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                webView.evaluateJavaScript("document.getElementById('retry')?.click()", completionHandler: nil)
            }
        }
        #endif
    }

    #if DEBUG
    private func runSmokeIfNeeded(in webView: WKWebView) {
        guard !smokeRan, let smoke = ProcessInfo.processInfo.environment["NS0_SMOKE"] else { return }
        smokeRan = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            switch smoke {
            case "external":
                webView.evaluateJavaScript("window.location.assign('https://example.com/')", completionHandler: nil)
            case "offline", "offline-retry":
                let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
                self.showOffline(for: error, in: webView)
            default:
                break
            }
        }
    }
    #endif
}
