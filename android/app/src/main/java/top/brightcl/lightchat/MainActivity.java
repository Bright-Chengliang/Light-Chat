package top.brightcl.lightchat;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

@SuppressWarnings("deprecation")
public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 4001;
    private static final String APP_USER_AGENT = " light-chat-android/1.0";

    private WebView webView;
    private View serviceConfigPanel;
    private android.widget.EditText serviceUrlInput;
    private TextView serviceConfigMessage;
    private View loadingOverlay;
    private View errorPanel;
    private TextView errorMessage;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean mainFrameLoadFailed;
    private String serviceUrl;
    private String trustedHost;

    private static final String SETTINGS_NAME = "light_chat_settings";
    private static final String SERVICE_URL_KEY = "service_url";

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        configureSystemBars();

        webView = findViewById(R.id.webView);
        serviceConfigPanel = findViewById(R.id.serviceConfigPanel);
        serviceUrlInput = findViewById(R.id.serviceUrlInput);
        serviceConfigMessage = findViewById(R.id.serviceConfigMessage);
        loadingOverlay = findViewById(R.id.loadingOverlay);
        errorPanel = findViewById(R.id.errorPanel);
        errorMessage = findViewById(R.id.errorMessage);
        Button retryButton = findViewById(R.id.retryButton);
        Button networkSettingsButton = findViewById(R.id.networkSettingsButton);
        Button changeServiceUrlButton = findViewById(R.id.changeServiceUrlButton);

        configureSafeAreaInsets();
        retryButton.setOnClickListener(view -> retry());
        networkSettingsButton.setOnClickListener(view -> openNetworkSettings());
        changeServiceUrlButton.setOnClickListener(view -> showServiceConfig(null));
        findViewById(R.id.saveServiceUrlButton).setOnClickListener(view -> saveServiceUrl());

        configureCookies();
        configureWebView();

        serviceUrl = loadSavedServiceUrl();
        if (serviceUrl == null) {
            showServiceConfig(null);
        } else if (savedInstanceState == null) {
            webView.loadUrl(serviceUrl);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private String loadSavedServiceUrl() {
        SharedPreferences preferences = getSharedPreferences(SETTINGS_NAME, MODE_PRIVATE);
        String saved = TrustedNavigation.normalizeServiceUrl(preferences.getString(SERVICE_URL_KEY, ""));
        if (saved != null) {
            trustedHost = Uri.parse(saved).getHost();
            return saved;
        }
        String buildDefault = TrustedNavigation.normalizeServiceUrl(BuildConfig.BASE_URL);
        if (buildDefault != null && !"https://chat.example.com/".equals(buildDefault)) {
            preferences.edit().putString(SERVICE_URL_KEY, buildDefault).apply();
            trustedHost = Uri.parse(buildDefault).getHost();
            return buildDefault;
        }
        return null;
    }

    private void showServiceConfig(String message) {
        serviceConfigPanel.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        loadingOverlay.setVisibility(View.GONE);
        errorPanel.setVisibility(View.GONE);
        if (serviceUrl != null) serviceUrlInput.setText(serviceUrl);
        if (message == null || message.isBlank()) {
            serviceConfigMessage.setVisibility(View.GONE);
        } else {
            serviceConfigMessage.setText(message);
            serviceConfigMessage.setVisibility(View.VISIBLE);
        }
        serviceUrlInput.requestFocus();
    }

    private void saveServiceUrl() {
        String normalized = TrustedNavigation.normalizeServiceUrl(serviceUrlInput.getText().toString());
        if (normalized == null) {
            showServiceConfig(getString(R.string.invalid_service_url));
            return;
        }
        serviceUrl = normalized;
        trustedHost = Uri.parse(normalized).getHost();
        getSharedPreferences(SETTINGS_NAME, MODE_PRIVATE).edit().putString(SERVICE_URL_KEY, normalized).apply();
        webView.clearHistory();
        webView.clearCache(false);
        serviceConfigPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        loadingOverlay.setVisibility(View.VISIBLE);
        errorPanel.setVisibility(View.GONE);
        webView.loadUrl(serviceUrl);
    }

    private void configureSystemBars() {
        getWindow().setStatusBarColor(Color.rgb(247, 246, 242));
        getWindow().setNavigationBarColor(Color.rgb(247, 246, 242));
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(lightBars, lightBars);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    private void configureCookies() {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, false);
        cookieManager.flush();
    }

    private void configureSafeAreaInsets() {
        if (Build.VERSION.SDK_INT < 35) return;
        View root = findViewById(R.id.appRoot);
        root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            int safeTypes = WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout();
            Insets safe = windowInsets.getInsets(safeTypes);
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);

            // WebView still receives IME updates, but not the system-bar/cutout insets
            // already applied by the native container. This prevents duplicate safe-area
            // padding while keeping keyboard viewport resizing functional.
            return new WindowInsets.Builder(windowInsets)
                    .setInsets(safeTypes, Insets.NONE)
                    .build();
        });
        root.requestApplyInsets();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setSaveFormData(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUserAgentString(settings.getUserAgentString() + APP_USER_AGENT);
        settings.setSafeBrowsingEnabled(true);

        webView.setWebViewClient(new LightChatWebViewClient());
        webView.setWebChromeClient(new LightChatChromeClient());
        webView.addJavascriptInterface(new SecureDownloadBridge(), "LightChatDownloads");
        webView.setDownloadListener(new SecureDownloadListener());
    }

    private void retry() {
        mainFrameLoadFailed = false;
        errorPanel.setVisibility(View.GONE);
        loadingOverlay.setVisibility(View.VISIBLE);
        if (!isNetworkAvailable()) {
            showError(getString(R.string.network_unavailable));
            return;
        }
        String current = webView.getUrl();
        if (current != null && TrustedNavigation.isTrusted(Uri.parse(current), trustedHost)) {
            webView.reload();
        } else {
            webView.loadUrl(serviceUrl);
        }
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null || manager.getActiveNetwork() == null) return false;
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void showError(String message) {
        mainFrameLoadFailed = true;
        serviceConfigPanel.setVisibility(View.GONE);
        loadingOverlay.setVisibility(View.GONE);
        errorMessage.setText(message);
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void openNetworkSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_WIRELESS_SETTINGS));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.no_network_settings, Toast.LENGTH_SHORT).show();
        }
    }

    private void openExternal(Uri uri) {
        if (!TrustedNavigation.canOpenExternally(uri)) {
            Toast.makeText(this, R.string.blocked_navigation, Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.no_external_browser, Toast.LENGTH_SHORT).show();
        }
    }

    private boolean handleNavigation(Uri uri) {
        if (TrustedNavigation.isTrusted(uri, trustedHost)) return false;
        openExternal(uri);
        return true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST) return;
        Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        if (filePathCallback != null) filePathCallback.onReceiveValue(result);
        filePathCallback = null;
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (errorPanel.getVisibility() == View.VISIBLE) {
            if (webView.canGoBack()) {
                mainFrameLoadFailed = false;
                errorPanel.setVisibility(View.GONE);
                loadingOverlay.setVisibility(View.VISIBLE);
                webView.goBack();
            } else {
                super.onBackPressed();
            }
            return;
        }
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) filePathCallback.onReceiveValue(null);
        filePathCallback = null;
        CookieManager.getInstance().flush();
        webView.stopLoading();
        webView.removeJavascriptInterface("LightChatDownloads");
        webView.setWebChromeClient(null);
        webView.setWebViewClient(null);
        webView.removeAllViews();
        webView.destroy();
        super.onDestroy();
    }

    private final class LightChatWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(request.getUrl());
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (TrustedNavigation.isTrusted(Uri.parse(url), trustedHost)) {
                mainFrameLoadFailed = false;
                errorPanel.setVisibility(View.GONE);
                loadingOverlay.setVisibility(View.VISIBLE);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!TrustedNavigation.isTrusted(Uri.parse(url), trustedHost)) return;
            CookieManager.getInstance().flush();
            if (mainFrameLoadFailed) return;
            loadingOverlay.setVisibility(View.GONE);
            errorPanel.setVisibility(View.GONE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError(getString(R.string.load_failed));
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 500) {
                showError(getString(R.string.service_unavailable));
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
            handler.cancel();
            showError(getString(R.string.ssl_error));
        }
    }

    private final class LightChatChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (filePathCallback != null) filePathCallback.onReceiveValue(null);
            filePathCallback = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            List<String> accepted = new ArrayList<>();
            for (String type : params.getAcceptTypes()) {
                if (type != null && !type.isBlank()) accepted.add(type.trim());
            }
            if (accepted.size() == 1) intent.setType(accepted.get(0));
            else {
                intent.setType("*/*");
                if (!accepted.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, accepted.toArray(new String[0]));
            }
            try {
                startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_files)), FILE_CHOOSER_REQUEST);
                return true;
            } catch (ActivityNotFoundException error) {
                filePathCallback = null;
                callback.onReceiveValue(null);
                Toast.makeText(MainActivity.this, R.string.no_file_picker, Toast.LENGTH_SHORT).show();
                return false;
            }
        }
    }

    private final class SecureDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
            Uri uri = Uri.parse(url);
            if ("blob".equalsIgnoreCase(uri.getScheme())) {
                String currentUrl = webView.getUrl();
                if (currentUrl == null || !TrustedNavigation.isTrusted(currentUrl, trustedHost)) {
                    Toast.makeText(MainActivity.this, R.string.blocked_download, Toast.LENGTH_SHORT).show();
                    return;
                }
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                exportBlobFromTrustedPage(url, fileName, mimeType);
                return;
            }
            if (!TrustedNavigation.isTrusted(uri, trustedHost)) {
                Toast.makeText(MainActivity.this, R.string.blocked_download, Toast.LENGTH_SHORT).show();
                return;
            }
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType).replaceAll("[\\\\/:*?\"<>|]", "_");
            DownloadManager.Request request = new DownloadManager.Request(uri)
                    .setTitle(fileName)
                    .setDescription(getString(R.string.download_description))
                    .setMimeType(mimeType)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isBlank()) request.addRequestHeader("Cookie", cookie);
            if (userAgent != null && !userAgent.isBlank()) request.addRequestHeader("User-Agent", userAgent);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) {
                Toast.makeText(MainActivity.this, R.string.download_failed, Toast.LENGTH_SHORT).show();
                return;
            }
            manager.enqueue(request);
            Toast.makeText(MainActivity.this, R.string.download_started, Toast.LENGTH_SHORT).show();
        }
    }

    private void exportBlobFromTrustedPage(String blobUrl, String fileName, String mimeType) {
        String script = "(async()=>{try{"
                + "const response=await fetch(" + JSONObject.quote(blobUrl) + ");"
                + "if(!response.ok)throw new Error('blob');"
                + "const blob=await response.blob();"
                + "const reader=new FileReader();"
                + "reader.onload=()=>{const value=String(reader.result||'');const comma=value.indexOf(',');"
                + "if(comma<0){LightChatDownloads.reportDownloadError();return;}"
                + "LightChatDownloads.saveBase64File(" + JSONObject.quote(fileName) + ",blob.type||"
                + JSONObject.quote(mimeType == null ? "" : mimeType) + ",value.slice(comma+1));};"
                + "reader.onerror=()=>LightChatDownloads.reportDownloadError();reader.readAsDataURL(blob);"
                + "}catch(error){LightChatDownloads.reportDownloadError();}})();";
        webView.evaluateJavascript(script, null);
    }

    private final class SecureDownloadBridge {
        @JavascriptInterface
        public void saveBase64File(String fileName, String mimeType, String base64Data) {
            runOnUiThread(() -> {
                String currentUrl = webView.getUrl();
                if (currentUrl == null || !TrustedNavigation.isTrusted(currentUrl, trustedHost)) {
                    Toast.makeText(MainActivity.this, R.string.blocked_download, Toast.LENGTH_SHORT).show();
                    return;
                }
                new Thread(() -> saveDownload(fileName, mimeType, base64Data), "light-chat-download").start();
            });
        }

        @JavascriptInterface
        public void reportDownloadError() {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, R.string.download_failed, Toast.LENGTH_SHORT).show());
        }
    }

    private void saveDownload(String fileName, String mimeType, String base64Data) {
        Uri destination = null;
        try {
            byte[] bytes = DownloadPayload.decode(base64Data);
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, DownloadPayload.safeFileName(fileName));
            values.put(MediaStore.Downloads.MIME_TYPE, DownloadPayload.safeMimeType(mimeType));
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            destination = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (destination == null) throw new IllegalStateException("无法创建下载文件");
            try (OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IllegalStateException("无法写入下载文件");
                output.write(bytes);
            }
            ContentValues complete = new ContentValues();
            complete.put(MediaStore.Downloads.IS_PENDING, 0);
            getContentResolver().update(destination, complete, null, null);
            runOnUiThread(() -> Toast.makeText(MainActivity.this, R.string.download_saved, Toast.LENGTH_SHORT).show());
        } catch (RuntimeException | java.io.IOException error) {
            if (destination != null) {
                try { getContentResolver().delete(destination, null, null); }
                catch (RuntimeException ignored) {}
            }
            runOnUiThread(() -> Toast.makeText(MainActivity.this, R.string.download_failed, Toast.LENGTH_SHORT).show());
        }
    }
}
