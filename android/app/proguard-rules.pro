# 保留所有带有 @JavascriptInterface 的方法和 Bridge 类，确保 WebView JSBridge 正常通信
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class top.brightcl.lightchat.MainActivity$NativeAppBridge { *; }
-keep class top.brightcl.lightchat.MainActivity$SecureDownloadBridge { *; }

