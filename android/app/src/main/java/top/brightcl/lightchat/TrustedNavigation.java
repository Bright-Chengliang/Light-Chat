package top.brightcl.lightchat;

import android.net.Uri;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

final class TrustedNavigation {
    private TrustedNavigation() {}

    static boolean isTrusted(Uri uri, String trustedOriginOrHost) {
        return uri != null && isTrusted(uri.toString(), trustedOriginOrHost);
    }

    static String normalizeServiceUrl(String rawUrl) {
        if (rawUrl == null) return null;
        String candidate = rawUrl.trim();
        if (candidate.isEmpty()) return null;
        try {
            URI uri = new URI(candidate);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            int port = uri.getPort();
            if (scheme == null || host == null) return null;
            String lowerScheme = scheme.toLowerCase(Locale.ROOT);
            if (!"https".equals(lowerScheme) && !"http".equals(lowerScheme)) return null;
            if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) return null;
            if (port != -1 && (port < 1 || port > 65535)) return null;

            StringBuilder normalized = new StringBuilder(lowerScheme).append("://").append(host.toLowerCase(Locale.ROOT));
            if (port != -1) {
                normalized.append(':').append(port);
            }
            if (uri.getRawPath() != null && !uri.getRawPath().isEmpty()) {
                normalized.append(uri.getRawPath());
            }
            if (normalized.charAt(normalized.length() - 1) != '/') {
                normalized.append('/');
            }
            return normalized.toString();
        } catch (URISyntaxException error) {
            return null;
        }
    }

    static boolean isTrusted(String rawUrl, String trustedOriginOrHost) {
        if (rawUrl == null || trustedOriginOrHost == null) return false;
        try {
            URI candidateUri = new URI(rawUrl);
            String candScheme = candidateUri.getScheme();
            String candHost = candidateUri.getHost();
            int candPort = candidateUri.getPort();
            if (candHost == null || candScheme == null) return false;
            String candLowerScheme = candScheme.toLowerCase(Locale.ROOT);
            if (!"https".equals(candLowerScheme) && !"http".equals(candLowerScheme)) return false;
            if (candidateUri.getUserInfo() != null) return false;

            if (trustedOriginOrHost.startsWith("http://") || trustedOriginOrHost.startsWith("https://")) {
                URI trustedUri = new URI(trustedOriginOrHost);
                String trustedScheme = trustedUri.getScheme();
                String trustedHost = trustedUri.getHost();
                int trustedPort = trustedUri.getPort();
                if (trustedHost == null || trustedScheme == null) return false;

                if (!candLowerScheme.equals(trustedScheme.toLowerCase(Locale.ROOT))) return false;
                if (!candHost.toLowerCase(Locale.ROOT).equals(trustedHost.toLowerCase(Locale.ROOT))) return false;

                int effectiveCandPort = candPort != -1 ? candPort : ("https".equals(candLowerScheme) ? 443 : 80);
                int effectiveTrustedPort = trustedPort != -1 ? trustedPort : ("https".equalsIgnoreCase(trustedScheme) ? 443 : 80);
                return effectiveCandPort == effectiveTrustedPort;
            } else {
                return candHost.toLowerCase(Locale.ROOT).equals(trustedOriginOrHost.toLowerCase(Locale.ROOT));
            }
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
