package com.workplease.sorryfix;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class SorryFixerTest {

    private static final String R = SorryFixer.REPLACEMENT;

    @Test
    public void replacesFinishedWord() {
        SorryFixer.Result r = SorryFixer.fix("sorry ", 6);
        assertEquals(R + " ", r.text);
        assertEquals(R.length() + 1, r.cursor);
    }

    @Test
    public void waitsUntilWordIsFinished() {
        assertNull(SorryFixer.fix("sorry", 5));
        assertNull(SorryFixer.fix("im sor", 6));
    }

    @Test
    public void anyCaseAndStretchedSpellings() {
        assertEquals(R + "!", SorryFixer.fix("SORRY!", 6).text);
        assertEquals("im " + R + " ", SorryFixer.fix("im Sorryyyy ", 12).text);
        assertEquals(R + ",", SorryFixer.fix("sry,", 4).text);
    }

    @Test
    public void ignoresOtherWords() {
        assertNull(SorryFixer.fix("sorrow is not sorryful ", 23));
        assertNull(SorryFixer.fix("hello there ", 12));
        assertNull(SorryFixer.fix("", 0));
    }

    @Test
    public void doesNotLoopOnItsOwnReplacement() {
        assertNull(SorryFixer.fix(R + " ", R.length() + 1));
        assertNull(SorryFixer.fix(R.toLowerCase() + " ok", 3));
    }

    @Test
    public void fixesNewSorryNextToOldReplacement() {
        String before = R + " sorry ";
        SorryFixer.Result r = SorryFixer.fix(before, before.length());
        assertEquals(R + " " + R + " ", r.text);
        assertEquals(r.text.length(), r.cursor);
    }

    @Test
    public void keepsCursorInPlaceWhenEditingEarlierText() {
        // Cursor sits after "hey" at index 3; the sorry comes later.
        SorryFixer.Result r = SorryFixer.fix("hey sorry ", 3);
        assertEquals("hey " + R + " ", r.text);
        assertEquals(3, r.cursor);
    }

    @Test
    public void unknownCursorGoesToEnd() {
        SorryFixer.Result r = SorryFixer.fix("sorry.", -1);
        assertEquals(r.text.length(), r.cursor);
    }
}
