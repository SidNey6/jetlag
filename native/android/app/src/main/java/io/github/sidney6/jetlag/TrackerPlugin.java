package io.github.sidney6.jetlag;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Brücke zwischen Web-App (js/native.js) und TrackerService:
 * start/stop der Aufzeichnung, Punkte abholen, Akku-Optimierung und Freigaben.
 */
@CapacitorPlugin(
    name = "JetlagTracker",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class TrackerPlugin extends Plugin {

    @Override
    public void load() {
        TrackerService.listener = (location) -> notifyListeners("fix", toJs(location));
    }

    @Override
    protected void handleOnDestroy() {
        TrackerService.listener = null;
        super.handleOnDestroy();
    }

    private boolean preciseLocation() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!preciseLocation()) {
            requestPermissionForAlias("location", call, "afterLocation");
            return;
        }
        askNotifications(call);
    }

    @PermissionCallback
    private void afterLocation(PluginCall call) {
        if (!preciseLocation()) {
            call.reject(getPermissionState("location") == PermissionState.GRANTED
                ? "Nur ungefährer Standort erlaubt – für die Spur bitte „Genauer Standort“ zulassen"
                : "Standortfreigabe fehlt", "NOT_AUTHORIZED");
            return;
        }
        askNotifications(call);
    }

    // Ohne Benachrichtigungsfreigabe läuft die Aufzeichnung trotzdem – man sieht sie
    // dann nur nicht in der Leiste. Gefragt wird deshalb, aber nicht darauf bestanden.
    private void askNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "afterNotifications");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void afterNotifications(PluginCall call) {
        startService(call);
    }

    private void startService(PluginCall call) {
        Intent intent = new Intent(getContext(), TrackerService.class).setAction(TrackerService.ACTION_START);
        String title = call.getString("title");
        String text = call.getString("text");
        if (title != null) intent.putExtra("title", title);
        if (text != null) intent.putExtra("text", text);
        try {
            ContextCompat.startForegroundService(getContext(), intent);
        } catch (Exception e) {
            call.reject("Aufzeichnung nicht gestartet: " + e.getMessage(), "START_FAILED");
            return;
        }
        JSObject r = new JSObject();
        r.put("running", true);
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE).edit().putBoolean("running", false).apply();
        try {
            getContext().startService(new Intent(getContext(), TrackerService.class).setAction(TrackerService.ACTION_STOP));
        } catch (Exception e) {
            getContext().stopService(new Intent(getContext(), TrackerService.class));
        }
        call.resolve();
    }

    /** Alle gespeicherten Punkte nach einem Zeitpunkt (ms), in Aufnahmereihenfolge. */
    @PluginMethod
    public void read(PluginCall call) {
        double after = call.getDouble("after", 0.0);
        JSArray points = new JSArray();
        File file = TrackerService.trackFile(getContext());
        if (file.exists()) {
            try (BufferedReader in = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                String line;
                while ((line = in.readLine()) != null) {
                    String[] p = line.split(",", -1);
                    if (p.length < 3) continue;
                    try {
                        long t = Long.parseLong(p[0]);
                        if (t <= after) continue;
                        JSObject o = new JSObject();
                        o.put("time", t);
                        o.put("lat", Double.parseDouble(p[1]));
                        o.put("lng", Double.parseDouble(p[2]));
                        if (p.length > 3 && !p[3].isEmpty()) o.put("accuracy", Double.parseDouble(p[3]));
                        if (p.length > 4 && !p[4].isEmpty()) o.put("speed", Double.parseDouble(p[4]));
                        if (p.length > 5 && !p[5].isEmpty()) o.put("heading", Double.parseDouble(p[5]));
                        points.put(o);
                    } catch (NumberFormatException ignore) {
                        // halb geschriebene letzte Zeile nach einem Absturz
                    }
                }
            } catch (IOException e) {
                call.reject("Spur nicht lesbar: " + e.getMessage());
                return;
            }
        }
        JSObject r = new JSObject();
        r.put("points", points);
        call.resolve(r);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        File file = TrackerService.trackFile(getContext());
        if (file.exists() && !file.delete()) {
            call.reject("Spur nicht gelöscht");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject r = new JSObject();
        r.put("running", TrackerService.isRunning(getContext()));
        r.put("precise", preciseLocation());
        r.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        r.put("batteryOptimized", pm != null && !pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(r);
    }

    /** Systemdialog „Akku-Optimierung ignorieren?“ – sonst stoppen manche Hersteller den Dienst. */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
        } catch (Exception e) {
            getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
        call.resolve();
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        getActivity().startActivity(intent);
        call.resolve();
    }

    private static JSObject toJs(Location l) {
        JSObject o = new JSObject();
        o.put("time", l.getTime());
        o.put("lat", l.getLatitude());
        o.put("lng", l.getLongitude());
        if (l.hasAccuracy()) o.put("accuracy", (double) l.getAccuracy());
        if (l.hasSpeed()) o.put("speed", (double) l.getSpeed());
        if (l.hasBearing()) o.put("heading", (double) l.getBearing());
        return o;
    }
}
