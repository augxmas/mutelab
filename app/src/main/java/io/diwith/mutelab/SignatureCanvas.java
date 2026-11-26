package io.diwith.mutelab;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.MotionEvent;
import android.view.View;
import java.util.ArrayList;

/**
 * 손가락 서명 입력 View.
 * 잉크는 이 View 위에만 그려지고, 저장 시 MainActivity가 PNG로 파일화한다(기기 안 보관).
 */
class SignatureCanvas extends View {

    private final Paint ink;
    private final ArrayList<float[]> strokes = new ArrayList<>();
    private float[] current;

    SignatureCanvas(Context context){
        super(context);
        ink = new Paint(Paint.ANTI_ALIAS_FLAG);
        ink.setColor(android.graphics.Color.BLACK);
        ink.setStrokeWidth(3f);
        ink.setStrokeCap(Paint.Cap.ROUND);
        ink.setStrokeJoin(Paint.Join.ROUND);
    }

    @Override protected void onDraw(Canvas canvas){
        super.onDraw(canvas);
        drawInk(canvas);
    }

    private void drawInk(Canvas canvas){
        for (float[] s : strokes) drawStroke(canvas, s);
        if (current != null) drawStroke(canvas, current);
    }

    private void drawStroke(Canvas canvas, float[] s){
        if (s == null || s.length < 4) return;
        for (int i = 2; i < s.length; i += 2) canvas.drawLine(s[i - 2], s[i - 1], s[i], s[i + 1], ink);
    }

    @Override public boolean onTouchEvent(MotionEvent e){
        switch (e.getAction()){
            case MotionEvent.ACTION_DOWN:
                current = new float[]{e.getX(), e.getY()};
                invalidate();
                return true;
            case MotionEvent.ACTION_MOVE:
                if (current != null){
                    current = java.util.Arrays.copyOf(current, current.length + 2);
                    current[current.length - 2] = e.getX();
                    current[current.length - 1] = e.getY();
                    invalidate();
                }
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (current != null){
                    if (current.length >= 4) strokes.add(current);
                    current = null;
                    invalidate();
                }
                if (e.getAction() == MotionEvent.ACTION_UP) performClick();
                return true;
            default:
                return false;
        }
    }

    @Override public boolean performClick(){
        super.performClick();
        return true;
    }

    boolean hasInk(){
        return !strokes.isEmpty();
    }

    void clear(){
        strokes.clear();
        current = null;
        invalidate();
    }

    Bitmap toBitmap(){
        int w = Math.max(1, getWidth());
        int h = Math.max(1, getHeight());
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        drawInk(new Canvas(b));
        return b;
    }
}
