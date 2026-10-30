package com.cewaycloud.ziwayos;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * 原生入口。
 *
 * 通知渠道在此创建而非放到 JS 里：渠道必须在任何推送到达前就存在，
 * 否则 FCM 找不到渠道会直接丢通知（不报错、只在 logcat 留一行）。
 */
public class MainActivity extends BridgeActivity {

    public static final String CHANNEL_MESSAGES = "ziwayos_messages";
    public static final String CHANNEL_ALERTS = "ziwayos_alerts";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createNotificationChannels();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Uri sound = Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.ziwayos_notify);
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();

        // 消息：高优先级，两声轻叩 + 双短振，锁屏不展示内容
        NotificationChannel messages = new NotificationChannel(
                CHANNEL_MESSAGES,
                "消息提醒",
                NotificationManager.IMPORTANCE_HIGH
        );
        messages.setDescription("门店动态、订单进展与到货提醒");
        messages.enableVibration(true);
        messages.setVibrationPattern(new long[]{0, 14, 70, 14});
        messages.setSound(sound, attrs);
        messages.enableLights(true);
        messages.setLightColor(Color.parseColor("#F97316"));
        messages.setShowBadge(true);
        messages.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(messages);

        // 系统：默认优先级，单次轻振，不发声
        NotificationChannel alerts = new NotificationChannel(
                CHANNEL_ALERTS,
                "系统提醒",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        alerts.setDescription("账户、结算与系统通告");
        alerts.enableVibration(true);
        alerts.setVibrationPattern(new long[]{0, 10});
        alerts.setShowBadge(true);
        alerts.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(alerts);
    }
}
