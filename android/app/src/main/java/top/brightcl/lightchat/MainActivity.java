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
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
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
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@SuppressWarnings("deprecation")
public final class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 4001;
    private static final String APP_USER_AGENT = " light-chat-android/1.0";

    private WebView webView;
    private View serviceConfigPanel;
    private EditText serviceUrlInput;
    private TextView serviceConfigMessage;
    private TextView serviceConfigCurrentUrl;
    private Button cancelServiceConfigButton;
    private View serviceHistoryLayout;
    private LinearLayout serviceHistoryList;
    private Button clearHistoryButton;
    private View loadingOverlay;
    private View errorPanel;
    private TextView errorMessage;
    private ValueCallback<Uri[]> filePathCallback;
    private boolean mainFrameLoadFailed;
    private String serviceUrl;
    private String trustedHost;

    private static final String SETTINGS_NAME = "light_chat_settings";
    private static final String SERVICE_URL_KEY = "service_url";
    private static final String SERVICE_URL_HISTORY_KEY = "service_url_history";
    private static final int MAX_HISTORY_COUNT = 10;

    private final Handler gestureHandler = new Handler(Looper.getMainLooper());
    private Runnable twoFingerLongPressRunnable;
    private boolean twoFingerTriggered;

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
        serviceConfigCurrentUrl = findViewById(R.id.serviceConfigCurrentUrl);
        cancelServiceConfigButton = findViewById(R.id.cancelServiceConfigButton);
        serviceHistoryLayout = findViewById(R.id.serviceHistoryLayout);
        serviceHistoryList = findViewById(R.id.serviceHistoryList);
        clearHistoryButton = findViewById(R.id.clearHistoryButton);
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
        if (cancelServiceConfigButton != null) {
            cancelServiceConfigButton.setOnClickListener(view -> cancelServiceConfig());
        }
        if (clearHistoryButton != null) {
            clearHistoryButton.setOnClickListener(view -> clearServiceUrlHistory());
        }

        configureCookies();
        configureWebView();
        configureTwoFingerGesture();

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
            saveServiceUrlToHistory(buildDefault);
            trustedHost = Uri.parse(buildDefault).getHost();
            return buildDefault;
        }
        return null;
    }

    private List<String> loadSavedServiceUrlHistory() {
        SharedPreferences preferences = getSharedPreferences(SETTINGS_NAME, MODE_PRIVATE);
        String raw = preferences.getString(SERVICE_URL_HISTORY_KEY, "[]");
        List<String> list = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                String item = arr.optString(i, "").trim();
                String normalized = TrustedNavigation.normalizeServiceUrl(item);
                if (normalized != null && !list.contains(normalized)) {
                    list.add(normalized);
                }
            }
        } catch (JSONException ignored) {}
        return list;
    }

    private void saveServiceUrlToHistory(String url) {
        String normalized = TrustedNavigation.normalizeServiceUrl(url);
        if (normalized == null) return;
        List<String> list = loadSavedServiceUrlHistory();
        list.remove(normalized);
        list.add(0, normalized);
        if (list.size() > MAX_HISTORY_COUNT) {
            list = list.subList(0, MAX_HISTORY_COUNT);
        }
        JSONArray arr = new JSONArray(list);
        getSharedPreferences(SETTINGS_NAME, MODE_PRIVATE)
                .edit()
                .putString(SERVICE_URL_HISTORY_KEY, arr.toString())
                .apply();
    }

    private void removeServiceUrlFromHistory(String url) {
        if (url == null) return;
        List<String> list = loadSavedServiceUrlHistory();
        list.remove(url);
        JSONArray arr = new JSONArray(list);
        getSharedPreferences(SETTINGS_NAME, MODE_PRIVATE)
                .edit()
                .putString(SERVICE_URL_HISTORY_KEY, arr.toString())
                .apply();
        renderServiceUrlHistory();
    }

    private void clearServiceUrlHistory() {
        getSharedPreferences(SETTINGS_NAME, MODE_PRIVATE)
                .edit()
                .remove(SERVICE_URL_HISTORY_KEY)
                .apply();
        renderServiceUrlHistory();
        Toast.makeText(this, R.string.clear_history, Toast.LENGTH_SHORT).show();
    }

    private void renderServiceUrlHistory() {
        if (serviceHistoryList == null || serviceHistoryLayout == null) return;
        serviceHistoryList.removeAllViews();
        List<String> history = loadSavedServiceUrlHistory();
        if (history.isEmpty()) {
            serviceHistoryLayout.setVisibility(View.GONE);
            return;
        }
        serviceHistoryLayout.setVisibility(View.VISIBLE);

        float density = getResources().getDisplayMetrics().density;
        int dp8 = (int) (8 * density);
        int dp10 = (int) (10 * density);
        int dp6 = (int) (6 * density);
        int dp4 = (int) (4 * density);

        for (String itemUrl : history) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rowParams.setMargins(0, dp4, 0, dp4);
            row.setLayoutParams(rowParams);
            row.setPadding(dp10, dp6, dp6, dp6);
            row.setBackgroundResource(R.drawable.brand_tile_soft);

            TextView label = new TextView(this);
            label.setText(itemUrl);
            label.setTextColor(Color.rgb(43, 41, 36));
            label.setTextSize(13);
            label.setSingleLine(true);
            label.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
            LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            label.setLayoutParams(labelParams);

            row.setOnClickListener(v -> {
                serviceUrlInput.setText(itemUrl);
                serviceUrlInput.setSelection(itemUrl.length());
            });

            Button useBtn = new Button(this, null, android.R.attr.borderlessButtonStyle);
            useBtn.setText(R.string.save_service_url);
            useBtn.setTextSize(11);
            useBtn.setTextColor(Color.rgb(166, 75, 55));
            useBtn.setPadding(dp8, 0, dp8, 0);
            useBtn.setOnClickListener(v -> applyAndSwitchServiceUrl(itemUrl));

            Button delBtn = new Button(this, null, android.R.attr.borderlessButtonStyle);
            delBtn.setText("✕");
            delBtn.setTextSize(12);
            delBtn.setTextColor(Color.rgb(140, 137, 130));
            delBtn.setPadding(dp6, 0, dp6, 0);
            delBtn.setOnClickListener(v -> removeServiceUrlFromHistory(itemUrl));

            row.addView(label);
            row.addView(useBtn);
            row.addView(delBtn);
            serviceHistoryList.addView(row);
        }
    }

    private void showServiceConfig(String message) {
        serviceConfigPanel.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
        loadingOverlay.setVisibility(View.GONE);
        errorPanel.setVisibility(View.GONE);

        if (serviceUrl != null && !serviceUrl.isBlank()) {
            serviceUrlInput.setText(serviceUrl);
            if (serviceConfigCurrentUrl != null) {
                serviceConfigCurrentUrl.setText(getString(R.string.current_service_url_prefix) + serviceUrl);
                serviceConfigCurrentUrl.setVisibility(View.VISIBLE);
            }
            if (cancelServiceConfigButton != null) {
                cancelServiceConfigButton.setVisibility(View.VISIBLE);
            }
        } else {
            if (serviceConfigCurrentUrl != null) {
                serviceConfigCurrentUrl.setVisibility(View.GONE);
            }
            if (cancelServiceConfigButton != null) {
                cancelServiceConfigButton.setVisibility(View.GONE);
            }
        }

        if (message == null || message.isBlank()) {
            serviceConfigMessage.setVisibility(View.GONE);
        } else {
            serviceConfigMessage.setText(message);
            serviceConfigMessage.setVisibility(View.VISIBLE);
        }

        renderServiceUrlHistory();
        serviceUrlInput.requestFocus();
    }

    private void cancelServiceConfig() {
        if (serviceUrl == null || serviceUrl.isBlank()) {
            Toast.makeText(this, R.string.invalid_service_url, Toast.LENGTH_SHORT).show();
            return;
        }
        serviceConfigPanel.setVisibility(View.GONE);
        if (mainFrameLoadFailed) {
            errorPanel.setVisibility(View.VISIBLE);
        } else {
            webView.setVisibility(View.VISIBLE);
        }
    }

    private void applyAndSwitchServiceUrl(String rawUrl) {
        String normalized = TrustedNavigation.normalizeServiceUrl(rawUrl);
        if (normalized == null) {
            showServiceConfig(getString(R.string.invalid_service_url));
            return;
        }
        serviceUrl = normalized;
        trustedHost = Uri.parse(normalized).getHost();
        getSharedPreferences(SETTINGS_NAME, MODE_PRIVATE).edit().putString(SERVICE_URL_KEY, normalized).apply();
        saveServiceUrlToHistory(normalized);

        webView.clearHistory();
        webView.clearCache(false);
        serviceConfigPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        loadingOverlay.setVisibility(View.VISIBLE);
        errorPanel.setVisibility(View.GONE);
        webView.loadUrl(serviceUrl);
    }

    private void saveServiceUrl() {
        applyAndSwitchServiceUrl(serviceUrlInput.getText().toString());
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
            return new WindowInsets.Builder(windowInsets)
                    .setInsets(safeTypes, Insets.NONE)
                    .build();
        });
        root.requestApplyInsets();
    }

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
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
        webView.addJavascriptInterface(new NativeAppBridge(this), "LightChatApp");
        webView.setDownloadListener(new SecureDownloadListener());
    }

    @SuppressLint("ClickableViewAccessibility")
    private void configureTwoFingerGesture() {
        twoFingerLongPressRunnable = () -> {
            twoFingerTriggered = true;
            Toast.makeText(MainActivity.this, R.string.service_config_title, Toast.LENGTH_SHORT).show();
            showServiceConfig(null);
        };

        webView.setOnTouchListener((view, event) -> {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_POINTER_DOWN) {
                if (event.getPointerCount() == 2) {
                    twoFingerTriggered = false;
                    gestureHandler.postDelayed(twoFingerLongPressRunnable, 900);
                }
            } else if (action == MotionEvent.ACTION_POINTER_UP || action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                gestureHandler.removeCallbacks(twoFingerLongPressRunnable);
            }
            return false;
        });
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
        if (current != null && isUrlTrusted(current)) {
            webView.reload();
        } else {
            webView.loadUrl(serviceUrl);
        }
    }

    private boolean isUrlTrusted(Uri uri) {
        if (uri == null) return false;
        String target = serviceUrl != null ? serviceUrl : trustedHost;
        return target != null && TrustedNavigation.isTrusted(uri, target);
    }

    private boolean isUrlTrusted(String rawUrl) {
        if (rawUrl == null) return false;
        String target = serviceUrl != null ? serviceUrl : trustedHost;
        return target != null && TrustedNavigation.isTrusted(rawUrl, target);
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
        if (uri == null) return false;
        String scheme = uri.getScheme();
        String raw = uri.toString().toLowerCase(Locale.ROOT);
        if ("lightchat".equalsIgnoreCase(scheme)
                || raw.startsWith("lightchat:")
                || raw.startsWith("lightchat://")
                || raw.contains("switch-endpoint")
                || raw.contains("action=switch-endpoint")) {
            runOnUiThread(() -> showServiceConfig(null));
            return true;
        }
        if (isUrlTrusted(uri)) return false;
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
    public boolean onKeyLongPress(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            showServiceConfig(null);
            return true;
        }
        return super.onKeyLongPress(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (serviceConfigPanel.getVisibility() == View.VISIBLE) {
            cancelServiceConfig();
            return;
        }
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
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) filePathCallback.onReceiveValue(null);
        filePathCallback = null;
        CookieManager.getInstance().flush();
        webView.stopLoading();
        webView.removeJavascriptInterface("LightChatDownloads");
        webView.removeJavascriptInterface("LightChatApp");
        webView.setWebChromeClient(null);
        webView.setWebViewClient(null);
        webView.removeAllViews();
        webView.destroy();
        super.onDestroy();
    }

    public static final class NativeAppBridge {
        private final java.lang.ref.WeakReference<MainActivity> activityRef;

        public NativeAppBridge(MainActivity activity) {
            this.activityRef = new java.lang.ref.WeakReference<>(activity);
        }

        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }

        @JavascriptInterface
        public String getCurrentServiceUrl() {
            MainActivity activity = activityRef.get();
            return activity != null && activity.serviceUrl != null ? activity.serviceUrl : "";
        }

        @JavascriptInterface
        public String getServiceUrlHistoryJson() {
            MainActivity activity = activityRef.get();
            if (activity == null) return "[]";
            List<String> history = activity.loadSavedServiceUrlHistory();
            return new JSONArray(history).toString();
        }

        @JavascriptInterface
        public void openEndpointConfig() {
            MainActivity activity = activityRef.get();
            if (activity != null) {
                activity.runOnUiThread(() -> activity.showServiceConfig(null));
            }
        }

        @JavascriptInterface
        public void switchEndpoint(String targetUrl) {
            MainActivity activity = activityRef.get();
            if (activity != null) {
                activity.runOnUiThread(() -> activity.applyAndSwitchServiceUrl(targetUrl));
            }
        }
    }

    private final class LightChatWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(request != null ? request.getUrl() : null);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(url != null ? Uri.parse(url) : null);
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (isUrlTrusted(url)) {
                mainFrameLoadFailed = false;
                errorPanel.setVisibility(View.GONE);
                loadingOverlay.setVisibility(View.VISIBLE);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!isUrlTrusted(url)) return;
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
        private void appendMimeType(List<String> accepted, String mimeType) {
            if (!accepted.contains(mimeType)) accepted.add(mimeType);
        }

        private void appendMimeTypesForExtension(List<String> accepted, String value) {
            String extension = value.toLowerCase(Locale.ROOT);
            if (extension.equals(".txt")) {
                appendMimeType(accepted, "text/plain");
                appendMimeType(accepted, "application/octet-stream");
            } else if (extension.equals(".pdf")) {
                appendMimeType(accepted, "application/pdf");
            } else if (extension.equals(".md") || extension.equals(".markdown")) {
                appendMimeType(accepted, "text/markdown");
            } else if (extension.equals(".epub") || extension.equals(".epub.zip")) {
                appendMimeType(accepted, "application/epub+zip");
            } else if (extension.equals(".doc")) {
                appendMimeType(accepted, "application/msword");
            } else if (extension.equals(".docx")) {
                appendMimeType(accepted, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            } else if (extension.equals(".ppt")) {
                appendMimeType(accepted, "application/vnd.ms-powerpoint");
            } else if (extension.equals(".pptx")) {
                appendMimeType(accepted, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
            }
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, android.webkit.JsPromptResult result) {
            if (message != null && message.startsWith("lightchat:")) {
                if ("lightchat:openEndpointConfig".equals(message)) {
                    runOnUiThread(() -> showServiceConfig(null));
                    result.confirm("ok");
                    return true;
                } else if (message.startsWith("lightchat:switchEndpoint:")) {
                    String target = message.substring("lightchat:switchEndpoint:".length());
                    runOnUiThread(() -> applyAndSwitchServiceUrl(target));
                    result.confirm("ok");
                    return true;
                }
            }
            return super.onJsPrompt(view, url, message, defaultValue, result);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (filePathCallback != null) filePathCallback.onReceiveValue(null);
            filePathCallback = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            List<String> accepted = new ArrayList<>();
            for (String type : params.getAcceptTypes()) {
                if (type == null || type.isBlank()) continue;
                for (String candidate : type.split(",")) {
                    String value = candidate.trim().toLowerCase(Locale.ROOT);
                    if (value.isEmpty()) continue;
                    if (value.startsWith(".")) {
                        appendMimeTypesForExtension(accepted, value);
                    } else if (value.equals("*/*") || value.contains("/")) {
                        appendMimeType(accepted, value);
                    }
                }
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
                if (currentUrl == null || !isUrlTrusted(currentUrl)) {
                    Toast.makeText(MainActivity.this, R.string.blocked_download, Toast.LENGTH_SHORT).show();
                    return;
                }
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                exportBlobFromTrustedPage(url, fileName, mimeType);
                return;
            }
            if (!isUrlTrusted(uri)) {
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
                if (currentUrl == null || !isUrlTrusted(currentUrl)) {
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

