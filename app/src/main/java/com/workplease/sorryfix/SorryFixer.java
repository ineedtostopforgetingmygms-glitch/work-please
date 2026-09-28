package com.workplease.sorryfix;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure text logic, no Android dependencies, so it can be unit tested on a plain JVM.
 *
 * A "sorry" is only replaced once the word is finished (followed by a space or
 * punctuation), the same way keyboard autocorrect waits for you to finish a word.
 */
public final class SorryFixer {

    public static final String REPLACEMENT = "Dont say that your good man its ok";

    // Every spelling of sorry, in any case, as a whole word followed by a non-letter:
    //   sorry sory soorry sorryyy   (s o r y, any letter stretched)
    //   sorri sorrie                (i/ie ending)
    //   sowwy sowy sowwie           (w instead of r)
    //   sry srry sryyy              (no o)
    //   soz sozz sozzy soza sorz    (British slang)
    private static final Pattern SORRY = Pattern.compile(
            "(?<![\\p{L}\\p{N}])"
                    + "(?:so+[rw]+(?:y+|i+e*)|sr+y+|so+z+(?:y+|a+)?|so+r+z+)"
                    + "(?=[^\\p{L}\\p{N}])",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);

    public static final class Result {
        public final String text;
        public final int cursor;

        Result(String text, int cursor) {
            this.text = text;
            this.cursor = cursor;
        }
    }

    private SorryFixer() {
    }

    /**
     * @param text   current contents of the text box
     * @param cursor current cursor position, or negative if unknown
     * @return the fixed text and where the cursor should go, or null if nothing changed
     */
    public static Result fix(String text, int cursor) {
        if (text == null || text.isEmpty()) {
            return null;
        }

        // If the replacement ever contains a "sorry", leave it alone so we can't loop forever.
        List<int[]> protectedRanges = findReplacementRanges(text);

        StringBuilder out = new StringBuilder(text.length() + REPLACEMENT.length());
        int newCursor = cursor < 0 ? -1 : cursor;
        int last = 0;
        boolean changed = false;

        Matcher m = SORRY.matcher(text);
        while (m.find()) {
            if (isProtected(m.start(), protectedRanges)) {
                continue;
            }
            out.append(text, last, m.start()).append(REPLACEMENT);
            if (newCursor >= m.end()) {
                newCursor += REPLACEMENT.length() - (m.end() - m.start());
            } else if (newCursor > m.start()) {
                newCursor = out.length();
            }
            last = m.end();
            changed = true;
        }

        if (!changed) {
            return null;
        }
        out.append(text, last, text.length());
        String result = out.toString();
        if (newCursor < 0 || newCursor > result.length()) {
            newCursor = result.length();
        }
        return new Result(result, newCursor);
    }

    private static List<int[]> findReplacementRanges(String text) {
        List<int[]> ranges = new ArrayList<>();
        int len = REPLACEMENT.length();
        for (int i = 0; i + len <= text.length(); i++) {
            if (text.regionMatches(true, i, REPLACEMENT, 0, len)) {
                ranges.add(new int[] {i, i + len});
                i += len - 1;
            }
        }
        return ranges;
    }

    private static boolean isProtected(int index, List<int[]> ranges) {
        for (int[] r : ranges) {
            if (index >= r[0] && index < r[1]) {
                return true;
            }
        }
        return false;
    }
}
