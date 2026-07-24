package top.brightcl.lightchat;

import android.net.Uri;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class TrustedNavigation {
    private TrustedNavigation() {}

    static boolean isTrusted(Uri uri, String trustedHost) {
        return uri != null && isTrusted(uri.toString(), trustedHost);
    }

    static boolean isTrusted(String rawUrl, String trustedHost) {
        if (rawUrl == null || trustedHost == null) return false;
        try {
            URI uri = new URI(rawUrl);
            String host = uri.getHost();
            int port = uri.getPort();
            return "https".equalsIgnoreCase(uri.getScheme())
                    && host != null
                    && host.toLowerCase(Locale.ROOT).equals(trustedHost.toLowerCase(Locale.ROOT))
                    && uri.getUserInfo() == null
                    && (port == -1 || port == 443);
        } catch (URISyntaxException error) {
            return false;
        }
    }

    static boolean canOpenExternally(Uri uri) {
        return uri != null && canOpenExternally(uri.toString());
    }

    static boolean canOpenExternally(String rawUrl) {
        if (rawUrl == null) return false;
        try {
            String scheme = new URI(rawUrl).getScheme();
            if (scheme == null) return false;
            String normalized = scheme.toLowerCase(Locale.ROOT);
            return normalized.equals("https") || normalized.equals("http") || normalized.equals("mailto");
        } catch (URISyntaxException error) {
            return false;
        }
    }
}
