package ai.idol.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

/**
 * A thin, honest shell around the offline bundle in assets/.
 *
 * There is no native networking in this app and no server anywhere. The engines
 * that index documents and compose cited answers run as JavaScript inside this
 * WebView, which is why the app works in aeroplane mode and why "load a folder
 * from the phone" is a file picker rather than an upload.
 *
 * The bundle is served over https://appassets.androidplatform.net/ rather than
 * file:///android_asset/. That is not cosmetic. A file:// page is an opaque
 * origin: IndexedDB and localStorage are unavailable there, so every document a
 * user loaded would disappear on restart. Android's own guidance is to serve
 * bundled files through WebViewAssetLoader, which gives them a real https origin
 * whose storage persists. The requests never leave the process — the loader
 * answers them from the APK — and the app holds no INTERNET permission, so
 * nothing here can reach a network even if it tried.
 */
public class MainActivity extends Activity {

    private static final int REQUEST_PICK = 1001;
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ORIGIN + "/assets/www/index.html";

    private WebView webView;
    private ValueCallback<Uri[]> pendingFilePicker;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        // The app is entirely local JavaScript; without this nothing runs.
        settings.setJavaScriptEnabled(true);
        // Storage: where the indexed documents live. Without these the corpus
        // vanishes on every restart, which to a user is data loss.
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        // No address bar means no reader mode, no share sheet, no text-selection
        // handles that make it feel like a browser tab.
        settings.setSupportMultipleWindows(false);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Everything under the asset origin is answered from the APK.
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Any link that is not the app's own origin opens in the real
                // browser; the app must never navigate away from its assets.
                return handleExternal(request.getUrl());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (pendingFilePicker != null) {
                    pendingFilePicker.onReceiveValue(null);
                }
                pendingFilePicker = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                // The folder input in the web UI asks for several files at once;
                // each one arrives as a separate URI in the result.
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, "Choose files"), REQUEST_PICK);
                } catch (Exception error) {
                    pendingFilePicker = null;
                    Toast.makeText(MainActivity.this, "No file picker available.", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
    }

    private boolean handleExternal(Uri uri) {
        if (uri == null) return true;
        if (uri.toString().startsWith(ORIGIN)) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // No browser installed: stay put rather than crash.
        }
        return true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_PICK) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (pendingFilePicker == null) return;
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int index = 0; index < count; index += 1) {
                    results[index] = data.getClipData().getItemAt(index).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[] { data.getData() };
            }
        }
        pendingFilePicker.onReceiveValue(results);
        pendingFilePicker = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
