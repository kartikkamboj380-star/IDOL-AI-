package ai.idol.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * A thin, honest shell around the offline bundle in assets/.
 *
 * There is no native networking in this app and no server anywhere. The engines
 * that index documents and compose cited answers run as JavaScript inside this
 * WebView, which is why the app works in aeroplane mode and why "load a folder
 * from the phone" is a file picker rather than an upload.
 *
 * Everything here exists to make a WebView behave like an app rather than a
 * browser tab: no address bar, no zoom, back navigates history, and the two file
 * inputs the web UI uses (files and a folder) are wired to Android's pickers.
 */
public class MainActivity extends Activity {

    private static final int REQUEST_PICK = 1001;

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
        settings.setDomStorageEnabled(true);
        // IndexedDB is where loaded documents live. Without database storage the
        // corpus vanishes on every restart, which looked like a data-loss bug.
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        // Content comes from assets and nowhere else.
        settings.setBlockNetworkLoads(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Any link that is not the app itself opens in the real browser;
                // the app must never navigate away from its own assets.
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
                // webkitdirectory: let the web UI ask for a whole folder, which is
                // how a repository or a notes directory gets loaded in one step.
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

        webView.loadUrl("file:///android_asset/www/index.html");
    }

    private boolean handleExternal(Uri uri) {
        if (uri == null) return true;
        String scheme = uri.getScheme();
        if ("file".equals(scheme)) return false;
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
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
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
