package io.diwith.mutelab;

import android.app.Application;

import com.google.android.material.color.DynamicColors;

public final class MuteLabApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        DynamicColors.applyToActivitiesIfAvailable(this);
    }
}
