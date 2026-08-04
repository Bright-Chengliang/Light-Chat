package top.brightcl.lightchat;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class DownloadPayloadTest {
    @Test
    public void decodesBoundedBase64Content() {
        byte[] expected = "Light-Chat 对话导出".getBytes(StandardCharsets.UTF_8);
        assertArrayEquals(expected, DownloadPayload.decode(Base64.getEncoder().encodeToString(expected)));
        assertThrows(IllegalArgumentException.class, () -> DownloadPayload.decode(""));
        assertThrows(IllegalArgumentException.class, () -> DownloadPayload.decode("%%%"));
    }

    @Test
    public void sanitizesFileNamesAndMimeTypes() {
        assertEquals("对话_记录_.md", DownloadPayload.safeFileName(" 对话/记录?.md "));
        assertEquals("light-chat-download", DownloadPayload.safeFileName(".."));
        assertEquals("text/plain", DownloadPayload.safeMimeType("Text/Plain; charset=utf-8"));
        assertEquals("application/octet-stream", DownloadPayload.safeMimeType("not a mime"));
    }
}
