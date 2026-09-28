package com.workplease.sorryfix;

import android.accessibilityservice.AccessibilityService;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Watches text boxes in every app and swaps "sorry" for the replacement phrase
 * as soon as you finish typing the word.
 */
public class SorryFixService extends AccessibilityService {

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() != AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED || event.isPassword()) {
            return;
        }
        AccessibilityNodeInfo node = event.getSource();
        if (node == null) {
            return;
        }
        try {
            if (!node.isEditable() || node.isPassword() || node.isShowingHintText()) {
                return;
            }
            CharSequence text = node.getText();
            if (text == null) {
                return;
            }
            SorryFixer.Result fixed = SorryFixer.fix(text.toString(), node.getTextSelectionEnd());
            if (fixed == null) {
                return;
            }

            Bundle setText = new Bundle();
            setText.putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, fixed.text);
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setText)) {
                return;
            }

            // Setting text can throw the cursor to the start; put it back where you were typing.
            Bundle selection = new Bundle();
            selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, fixed.cursor);
            selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, fixed.cursor);
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection);
        } finally {
            node.recycle();
        }
    }

    @Override
    public void onInterrupt() {
    }
}
