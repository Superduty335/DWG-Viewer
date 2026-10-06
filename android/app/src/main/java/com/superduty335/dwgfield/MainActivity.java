package com.superduty335.dwgfield;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setIntent(sharedFileAsView(getIntent()));
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(sharedFileAsView(intent));
    }

    // "Share to DWG-Field" arrives as ACTION_SEND with the file in EXTRA_STREAM.
    // Turn it into the same ACTION_VIEW intent that "Open with" sends, so the web app
    // receives it through the App plugin's appUrlOpen / getLaunchUrl like any other file.
    private Intent sharedFileAsView(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return intent;
        Uri stream;
        if (Build.VERSION.SDK_INT >= 33) {
            stream = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        } else {
            stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (stream == null) return intent;
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(stream, intent.getType() != null ? intent.getType() : "application/octet-stream");
        view.setClipData(intent.getClipData());
        view.addFlags(intent.getFlags());
        return view;
    }
}
