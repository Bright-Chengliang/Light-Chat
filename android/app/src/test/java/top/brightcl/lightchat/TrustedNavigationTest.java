package top.brightcl.lightchat;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class TrustedNavigationTest {
    @Test
    public void acceptsOnlyExactHttpsServiceOrigin() {
        assertTrue(TrustedNavigation.isTrusted("https://chat.example.com/app", "chat.example.com"));
        assertTrue(TrustedNavigation.isTrusted("https://chat.example.com:443/api/session", "chat.example.com"));
        assertFalse(TrustedNavigation.isTrusted("http://chat.example.com/app", "chat.example.com"));
        assertFalse(TrustedNavigation.isTrusted("https://chat.example.com.evil.example/app", "chat.example.com"));
        assertFalse(TrustedNavigation.isTrusted("https://user@chat.example.com/app", "chat.example.com"));
        assertFalse(TrustedNavigation.isTrusted("https://chat.example.com:8443/app", "chat.example.com"));
    }

    @Test
    public void allowsOnlyOrdinaryExternalSchemes() {
        assertTrue(TrustedNavigation.canOpenExternally("https://example.com"));
        assertTrue(TrustedNavigation.canOpenExternally("mailto:test@example.com"));
        assertFalse(TrustedNavigation.canOpenExternally("javascript:alert(1)"));
        assertFalse(TrustedNavigation.canOpenExternally("file:///sdcard/private.txt"));
        assertFalse(TrustedNavigation.canOpenExternally("content://contacts/1"));
    }
}
