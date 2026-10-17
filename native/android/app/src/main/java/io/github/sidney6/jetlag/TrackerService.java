package io.github.sidney6.jetlag;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Endgame-Aufzeichnung als Vordergrunddienst: Jeder GPS-Punkt landet sofort in einer
 * Datei im App-Speicher – unabhängig von der Web-Oberfläche, die Android im Hintergrund
 * drosseln oder ganz beenden darf. Die App holt die Punkte beim Zurückkehren ab
 * (TrackerPlugin.read).
 *
 * Der Dienst läuft weiter, wenn der Bildschirm aus ist, eine andere App vorne liegt oder
 * die App aus der Übersicht gewischt wird (stopWithTask=false), und startet nach einem
 * Beenden durch das System neu (START_STICKY).
 */
public class TrackerService extends Service implements LocationListener {

    static final String ACTION_START = "io.github.sidney6.jetlag.TRACK_START";
    static final String ACTION_STOP = "io.github.sidney6.jetlag.TRACK_STOP";
    static final String FILE = "endgame-track.csv";
    static final String PREFS = "jetlag-tracker";
    private static final String CHANNEL = "endgame";
    private static final int NOTIFICATION_ID = 4711;
    private static final String TAG = "JetlagTracker";

    /** Meldet neue Punkte an die laufende App (falls es eine gibt). */
    interface Listener { void onFix(Location location); }

    static volatile Listener listener = null;

    private LocationManager locations;
    private boolean listening = false;

    static File trackFile(Context context) {
        return new File(context.getFilesDir(), FILE);
    }

    static boolean isRunning(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("running", false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) {
            prefs.edit().putBoolean("running", false).apply();
            stopListening();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        // Neustart durch das System (intent == null): nur weitermachen, wenn die
        // Aufzeichnung nicht inzwischen beendet wurde
        if (action == null && !prefs.getBoolean("running", false)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            if (intent.hasExtra("title")) prefs.edit().putString("title", intent.getStringExtra("title")).apply();
            if (intent.hasExtra("text")) prefs.edit().putString("text", intent.getStringExtra("text")).apply();
        }
        prefs.edit().putBoolean("running", true).apply();

        Notification notification = buildNotification(
            prefs.getString("title", "Endgame-Aufzeichnung läuft"),
            prefs.getString("text", "Die Spur wird auch bei gesperrtem Bildschirm erfasst."));
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
        } catch (Exception e) {
            // z. B. Standortfreigabe zurückgezogen: ohne Freigabe keine Aufzeichnung
            Log.e(TAG, "Vordergrunddienst nicht gestartet", e);
            prefs.edit().putBoolean("running", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        startListening();
        return START_STICKY;
    }

    private void startListening() {
        if (listening) return;
        locations = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            // Jede Sekunde, ohne Mindestabstand: die Spur filtert die App selbst
            locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, Looper.getMainLooper());
            listening = true;
        } catch (SecurityException | IllegalArgumentException e) {
            Log.e(TAG, "GPS nicht verfügbar", e);
        }
    }

    private void stopListening() {
        if (listening && locations != null) locations.removeUpdates(this);
        listening = false;
    }

    @Override
    public void onLocationChanged(Location l) {
        // Zeit, Breite, Länge, Genauigkeit, Tempo, Richtung – eine Zeile je Punkt
        String line = String.format(Locale.ROOT, "%d,%.7f,%.7f,%s,%s,%s\n",
            l.getTime(), l.getLatitude(), l.getLongitude(),
            l.hasAccuracy() ? String.format(Locale.ROOT, "%.1f", l.getAccuracy()) : "",
            l.hasSpeed() ? String.format(Locale.ROOT, "%.2f", l.getSpeed()) : "",
            l.hasBearing() ? String.format(Locale.ROOT, "%.1f", l.getBearing()) : "");
        try (FileOutputStream out = new FileOutputStream(trackFile(this), true)) {
            out.write(line.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            Log.e(TAG, "Punkt nicht gespeichert", e);
        }
        Listener l2 = listener;
        if (l2 != null) {
            try { l2.onFix(l); } catch (Exception e) { Log.e(TAG, "Weitergabe fehlgeschlagen", e); }
        }
    }

    @Override public void onProviderEnabled(String provider) {}
    @Override public void onProviderDisabled(String provider) {}

    private Notification buildNotification(String title, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Endgame-Aufzeichnung", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Zeigt an, dass die Spur im Hintergrund aufgezeichnet wird");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_track)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    @Override
    public void onDestroy() {
        stopListening();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
