package top.brightcl.lightchat;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public final class TrustedNavigationTest {
    @Test
    public void acceptsServiceOriginWithHttpOrHttps() {
        assertTrue(TrustedNavigation.isTrusted("https://example.com/app", "https://example.com/"));
        assertTrue(TrustedNavigation.isTrusted("https://example.com:443/api/session", "https://example.com/"));
        assertTrue(TrustedNavigation.isTrusted("https://example.com/learning/", "https://example.com/"));
        assertTrue(TrustedNavigation.isTrusted("http://192.168.1.100:3000/app", "http://192.168.1.100:3000/"));
        assertTrue(TrustedNavigation.isTrusted("http://localhost:3000/", "http://localhost:3000/"));
        assertTrue(TrustedNavigation.isTrusted("https://example.com:8443/app", "https://example.com:8443/"));

        assertFalse(TrustedNavigation.isTrusted("http://example.com/app", "https://example.com/"));
        assertFalse(TrustedNavigation.isTrusted("http://192.168.1.101:3000/", "http://192.168.1.100:3000/"));
        assertFalse(TrustedNavigation.isTrusted("https://example.com.evil.example/app", "https://example.com/"));
        assertFalse(TrustedNavigation.isTrusted("https://user@example.com/app", "https://example.com/"));
    }

    @Test
    public void allowsOnlyOrdinaryExternalSchemes() {
        assertTrue(TrustedNavigation.canOpenExternally("https://example.com"));
        assertTrue(TrustedNavigation.canOpenExternally("http://example.com"));
        assertTrue(TrustedNavigation.canOpenExternally("mailto:test@example.com"));
        assertFalse(TrustedNavigation.canOpenExternally("javascript:alert(1)"));
        assertFalse(TrustedNavigation.canOpenExternally("file:///sdcard/private.txt"));
        assertFalse(TrustedNavigation.canOpenExternally("content://contacts/1"));
    }

    @Test
    public void normalizesConfiguredServiceUrls() {
        assertEquals("https://chat.example.com/", TrustedNavigation.normalizeServiceUrl("https://chat.example.com"));
        assertEquals("https://example.com/light-chat/", TrustedNavigation.normalizeServiceUrl("https://example.com/light-chat"));
        assertEquals("http://192.168.1.100:3000/", TrustedNavigation.normalizeServiceUrl("http://192.168.1.100:3000"));
        assertEquals("http://localhost:3000/chat/", TrustedNavigation.normalizeServiceUrl("http://localhost:3000/chat"));
        assertEquals("https://example.com:8443/", TrustedNavigation.normalizeServiceUrl("https://example.com:8443"));

        assertNull(TrustedNavigation.normalizeServiceUrl("ftp://example.com/"));
        assertNull(TrustedNavigation.normalizeServiceUrl("https://user@example.com/"));
        assertNull(TrustedNavigation.normalizeServiceUrl("https://example.com/?next=evil"));
        assertNull(TrustedNavigation.normalizeServiceUrl("https://example.com/#hash"));
    }
}
