package top.brightcl.lightchat;

import java.util.Base64;
import java.util.Locale;

final class DownloadPayload {
    static final int MAX_BYTES = 64 * 1024 * 1024;
    private static final String FALLBACK_NAME = "light-chat-download";
    private static final String FALLBACK_MIME = "application/octet-stream";

    private DownloadPayload() {}

    static byte[] decode(String base64Data) {
        if (base64Data == null || base64Data.isBlank()) throw new IllegalArgumentException("下载内容为空");
        long maximumEncodedLength = ((long) MAX_BYTES + 2L) / 3L * 4L + 4L;
        if (base64Data.length() > maximumEncodedLength) throw new IllegalArgumentException("下载内容过大");
        byte[] bytes = Base64.getDecoder().decode(base64Data);
        if (bytes.length > MAX_BYTES) throw new IllegalArgumentException("下载内容过大");
        return bytes;
    }

    static String safeFileName(String value) {
        String cleaned = value == null ? "" : value
                .replaceAll("[\\p{Cntrl}\\\\/:*?\"<>|]", "_")
                .trim();
        if (cleaned.equals(".") || cleaned.equals("..")) cleaned = "";
        if (cleaned.length() > 160) cleaned = cleaned.substring(0, 160).trim();
        return cleaned.isEmpty() ? FALLBACK_NAME : cleaned;
    }

    static String safeMimeType(String value) {
        if (value == null) return FALLBACK_MIME;
        String normalized = value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return normalized.matches("[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+") ? normalized : FALLBACK_MIME;
    }
}
