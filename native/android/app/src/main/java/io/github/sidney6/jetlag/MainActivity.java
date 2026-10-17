package io.github.sidney6.jetlag;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Eigene Plugins vor dem Start der Brücke anmelden
        registerPlugin(TrackerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
