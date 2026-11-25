package io.diwith.mutelab;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.pdf.PdfRenderer;
import android.graphics.drawable.GradientDrawable;
import android.location.Location;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.Uri;
import android.graphics.drawable.ColorDrawable;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.*;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.Window;
import android.view.WindowManager;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.Animation;
import android.view.animation.TranslateAnimation;
import android.widget.*;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.*;

public class MainActivity extends Activity {
    private static final int INK=Color.rgb(39,55,48), MUTED=Color.rgb(104,117,109), BG=Color.rgb(247,247,242), BLUE=Color.rgb(62,96,81), GREEN=Color.rgb(62,96,81), CREAM=Color.rgb(246,243,235), SAGE=Color.rgb(239,243,237), PEACH=Color.rgb(231,220,202), CARD=Color.rgb(242,245,240), BUTTON_ALT=Color.rgb(226,236,229), BORDER=Color.rgb(218,225,217), BUTTON_BORDER=Color.rgb(199,216,204), PAPER=Color.rgb(252,251,247);
    // 녹음 레코드(String[]) 인덱스: 0 id · 1 파일 · 2/3 시작/종료 · 4 종류 · 5 장소 · 6 피해 · 7 범위의견 · 8 신호패턴 · 9/10 dBFS · 11 버킷 · 12~15 (미사용) · 16 상태 · 17/18 사유 · 19 동의 · 20 특징 · 21 로그버전 · 22 위도 · 23 경도 · 24 정확도 · 25 네트워크 · 26 최고ms · 27 최저ms · 28 공개IP · 29 태그
    private static final int ROW_MIN = 40;
    private static final int R_LAT=22,R_LON=23,R_ACC=24,R_NET=25,R_PEAK_MS=26,R_LOW_MS=27,R_IP=28,R_TAG=29;
    private static final int R_RECORD_NO=30,R_AUDIO_HASH=31,R_REPORT_STATE=32;
    private static final int R_PEAK_DB=33,R_LOW_DB=34;
    private static final int R_REPORT_OMITTED=35;
    private static final int R_OTHER_NAME=36,R_OTHER_DONG=37,R_OTHER_HO=38,R_FREQUENCY=39;
    private final Set<String> analyzingRecordings = new HashSet<>();
    private final Map<String, List<Runnable>> recordingUploads = new HashMap<>();
    private static final ExecutorService RECORDING_UPLOAD_EXECUTOR = Executors.newSingleThreadExecutor();
    private LinearLayout root, body;
    private String page="홈";
    private MediaRecorder recorder;
    private long startedAt;
    private File activeFile;
    private TextView timer;
    private final Handler handler=new Handler();
    private MediaPlayer player;
    private String playbackRecordId = "";
    private TextView playbackFilename;
    private TextView playbackLevels;
    private Dialog playbackDialog;
    private SeekBar playbackSeek;
    private TextView playbackTime;
    private TextView playbackElapsed;
    private TextView managerDocLabel;
    private ImageView signaturePreview;
    private static final int REQUEST_MANAGER_DOCUMENT=71;
    private final Runnable playbackTick=new Runnable(){@Override public void run(){if(player==null||playbackDialog==null||!playbackDialog.isShowing())return;try{int pos=player.getCurrentPosition();playbackSeek.setProgress(pos);if(playbackElapsed!=null)playbackElapsed.setText(playTime(pos));if(playbackTime!=null)playbackTime.setText(playTime(player.getDuration()));handler.postDelayed(this,400);}catch(Exception ignored){}}};
    private String analysisId="";
    private String[] place={"","","",""};
    private final Runnable tick=()->{if(recorder!=null&&timer!=null){timer.setText(elapsed());handler.postDelayed(this.tick,1000);}};
    private final String[] tabs={"홈","소음측정","소음기록","제출양식","층간소음안내","층간소음보고서","내 정보","계정"};
    private static final String DEFAULT_API_BASE_URL="https://mutelab.kr/api";
    private static final ExecutorService API_EXECUTOR=Executors.newSingleThreadExecutor();
    private interface ApiCallback{void onResult(JSONObject data,String error);}
    private static final int REQUEST_FORM_DOWNLOAD=72;
    private String pendingFormDownloadId="";
    private static final int REQUEST_REPORT_EXPORT=73;
    private boolean notificationsChecked;
    private boolean committeeReportSyncRunning;
    private boolean authenticationExpiryHandled;
    private static final String COMMITTEE_SYNC_PREFIX="committee_submission_sync_";

    @Override public void onCreate(Bundle b){super.onCreate(b);getWindow().setStatusBarColor(BG);getWindow().setNavigationBarColor(BG);getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);if(!getPreferences(0).getBoolean("auto_login",true))getPreferences(0).edit().remove("auth_token").remove("auth_login_id").remove("auth_email").apply();render();if(!getPreferences(0).getString("auth_token","").isEmpty())handler.postDelayed(this::syncReportedCommitteeSubmissions,1200);}
    @Override protected void onResume(){super.onResume();handler.postDelayed(()->{notificationsChecked=false;checkResidentNotifications();},700);}
    @Override public void onBackPressed(){if(!"홈".equals(page)){page="홈";render();}else super.onBackPressed();}
    private int dp(float n){return (int)(n*getResources().getDisplayMetrics().density+.5f);}
    private TextView text(String s,int size,int color,boolean bold){TextView v=new TextView(this);v.setText(s==null?"":s);v.setTextSize(size);v.setTextColor(color);v.setFontFeatureSettings("kern");if(bold)v.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));return v;}
    private LinearLayout column(){LinearLayout l=new LinearLayout(this);l.setOrientation(LinearLayout.VERTICAL);return l;}
    private final class ActionRow extends LinearLayout{ActionRow(){super(MainActivity.this);setOrientation(HORIZONTAL);setGravity(Gravity.CENTER_VERTICAL);}@Override public void addView(View child,ViewGroup.LayoutParams params){if(child instanceof Button&&getChildCount()>0&&params instanceof LinearLayout.LayoutParams){LinearLayout.LayoutParams lp=(LinearLayout.LayoutParams)params;lp.leftMargin=Math.max(lp.leftMargin,dp(8));}super.addView(child,params);}}
    private LinearLayout row(){return new ActionRow();}
    private void pad(View v,int l,int t,int r,int b){v.setPadding(dp(l),dp(t),dp(r),dp(b));}
    private void gap(LinearLayout l,int h){View v=new View(this);l.addView(v,new LinearLayout.LayoutParams(1,dp(h)));}
    private void card(LinearLayout parent,View inner){LinearLayout box=column();GradientDrawable surface=new GradientDrawable();surface.setColor(CARD);surface.setCornerRadius(dp(18));surface.setStroke(dp(1),BORDER);box.setBackground(surface);pad(box,16,15,16,15);box.addView(inner);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.bottomMargin=dp(10);parent.addView(box,lp);}
    private void styleSurface(View view,int color,int radius,int stroke){GradientDrawable shape=new GradientDrawable();shape.setColor(color);shape.setCornerRadius(dp(radius));if(stroke!=Color.TRANSPARENT)shape.setStroke(dp(1),stroke);view.setBackground(shape);}
    private Button button(String label,boolean primary,Runnable action){return button(label,null,primary,action);}private Button button(String icon,String label,boolean primary,Runnable action){Button b=new Button(this);b.setText((icon==null?"":icon+"  ")+(label==null?"":label));b.setAllCaps(false);b.setTextSize(14);b.setTypeface(Typeface.create("sans-serif-medium",Typeface.NORMAL));b.setTextColor(primary?Color.WHITE:INK);styleSurface(b,primary?BLUE:BUTTON_ALT,14,primary?Color.TRANSPARENT:BUTTON_BORDER);b.setMinHeight(dp(48));b.setPadding(dp(14),dp(9),dp(14),dp(9));b.setElevation(0);b.setOnClickListener(v->action.run());return b;}
    private TextView pill(String label){TextView v=text(label,12,BLUE,true);v.setGravity(Gravity.CENTER);v.setPadding(dp(12),dp(6),dp(12),dp(6));GradientDrawable g=new GradientDrawable();g.setColor(SAGE);g.setCornerRadius(dp(14));g.setStroke(dp(1),BORDER);v.setBackground(g);return v;}private LinearLayout soundBars(){LinearLayout l=row();int[] h={dp(10),dp(22),dp(15)};int[] c={BLUE,PEACH,Color.rgb(198,211,200)};for(int i=0;i<3;i++){View bar=new View(this);GradientDrawable d=new GradientDrawable();d.setColor(c[i]);d.setCornerRadius(dp(5));bar.setBackground(d);l.addView(bar,new LinearLayout.LayoutParams(dp(7),h[i]));}return l;}private interface ModalAction{boolean run();}
    private TextView modalAction(String label,boolean primary,boolean danger){String value=label==null?"":label;String ico=null;if(value.indexOf("닫기")>=0||value.indexOf("삭제")>=0)ico="✕";else if(value.indexOf("취소")>=0||value.indexOf("돌아가기")>=0)ico="↩";else if(value.indexOf("저장")>=0||value.indexOf("확인")>=0)ico="✓";TextView b=text((ico==null?"":ico+"  ")+value,14,primary?Color.WHITE:INK,true);b.setGravity(Gravity.CENTER);b.setMinWidth(dp(84));b.setMinHeight(dp(46));b.setPadding(dp(16),dp(10),dp(16),dp(10));GradientDrawable bg=new GradientDrawable();bg.setColor(primary?(danger?Color.rgb(168,76,67):BLUE):BUTTON_ALT);bg.setCornerRadius(dp(14));if(!primary)bg.setStroke(dp(1),BUTTON_BORDER);b.setBackground(bg);b.setClickable(true);b.setFocusable(true);return b;}
    private Dialog showCustomDialog(String heading,View content,String positive,String secondary,boolean danger,ModalAction onPositive,ModalAction onSecondary){Dialog dialog=new Dialog(this);dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);LinearLayout shell=column();GradientDrawable shellBg=new GradientDrawable();shellBg.setColor(PAPER);shellBg.setCornerRadius(dp(24));shell.setBackground(shellBg);shell.setElevation(dp(8));pad(shell,22,20,22,18);LinearLayout headingRow=row();TextView badge=text(danger?"!":"✓",16,danger?Color.rgb(168,76,67):BLUE,true);badge.setGravity(Gravity.CENTER);GradientDrawable badgeBg=new GradientDrawable();badgeBg.setShape(GradientDrawable.OVAL);badgeBg.setColor(danger?Color.rgb(250,235,231):SAGE);badge.setBackground(badgeBg);headingRow.addView(badge,new LinearLayout.LayoutParams(dp(38),dp(38)));LinearLayout titleBox=column();pad(titleBox,12,0,0,0);titleBox.addView(text(heading,19,INK,true));titleBox.addView(text("MUTELAB · 확인",10,MUTED,true));headingRow.addView(titleBox,new LinearLayout.LayoutParams(0,-2,1));shell.addView(headingRow);if(content!=null){gap(shell,15);shell.addView(content);}gap(shell,18);LinearLayout actions=row();actions.setGravity(Gravity.END);if(secondary!=null&&!secondary.isEmpty()){TextView cancel=modalAction(secondary,false,false);LinearLayout.LayoutParams cp=new LinearLayout.LayoutParams(-2,-2);cp.rightMargin=dp(8);actions.addView(cancel,cp);cancel.setOnClickListener(v->{if(onSecondary==null||onSecondary.run())dialog.dismiss();});}if(positive!=null&&!positive.isEmpty()){TextView confirm=modalAction(positive,true,danger);actions.addView(confirm);confirm.setOnClickListener(v->{if(onPositive==null||onPositive.run())dialog.dismiss();});}shell.addView(actions);dialog.setContentView(shell);dialog.setCancelable(true);dialog.setCanceledOnTouchOutside(true);dialog.show();Window window=dialog.getWindow();if(window!=null){window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);WindowManager.LayoutParams lp=window.getAttributes();lp.width=Math.min(dp(420),getResources().getDisplayMetrics().widthPixels-dp(36));lp.height=WindowManager.LayoutParams.WRAP_CONTENT;lp.gravity=Gravity.CENTER;lp.dimAmount=.42f;window.setAttributes(lp);}return dialog;}
    private void showMessageDialog(String heading,String message,boolean success){LinearLayout content=column();TextView body=text(message,14,MUTED,false);body.setLineSpacing(dp(3),1f);content.addView(body);showCustomDialog(heading,content,"확인",null,!success,()->true,null);}
    private EditText input(String hint,int type){EditText e=new EditText(this);e.setSingleLine(false);e.setHint(hint);e.setHintTextColor(MUTED);e.setTextSize(15);e.setTextColor(INK);e.setInputType(type);e.setPadding(dp(14),dp(11),dp(14),dp(11));styleSurface(e,PAPER,13,BORDER);return e;}
    private void render(){
        root=column();root.setBackgroundColor(BG);setContentView(root);
        LinearLayout header=row();header.setBackgroundColor(BG);pad(header,16,10,12,10);
        MenuIcon hamb=new MenuIcon(this);
        hamb.setClickable(true);hamb.setFocusable(true);hamb.setOnClickListener(v->showMenuDrawer());
        header.addView(hamb,new LinearLayout.LayoutParams(dp(48),dp(48)));
        TextView headerTitle=text("MuteLab",19,INK,true);pad(headerTitle,12,0,0,0);
        header.addView(headerTitle,new LinearLayout.LayoutParams(0,-2,1));
        root.addView(header,new LinearLayout.LayoutParams(-1,dp(58)));
        ScrollView scroll=new ScrollView(this);scroll.setClipToPadding(false);body=column();pad(body,18,16,18,100);scroll.addView(body);
        FrameLayout content=new FrameLayout(this);content.addView(scroll,new LinearLayout.LayoutParams(-1,-1));
        root.addView(content,new LinearLayout.LayoutParams(-1,0,1));
        int fx=getPreferences(0).getInt("fab_x",0),fy=getPreferences(0).getInt("fab_y",0);
        FrameLayout.LayoutParams flp;
        if(fx>0||fy>0){flp=new FrameLayout.LayoutParams(dp(64),dp(64),Gravity.LEFT|Gravity.TOP);flp.leftMargin=fx;flp.topMargin=fy;}
        else{flp=new FrameLayout.LayoutParams(dp(64),dp(64),Gravity.END|Gravity.BOTTOM);flp.setMargins(0,0,dp(18),dp(16));}
        RFab fab=new RFab(this);
        if("홈".equals(page))fab.setVisibility(View.GONE);
        fab.setRecording(recorder!=null);
        fab.setContentDescription(recorder==null?"녹음 시작":"녹음 종료");
        fab.setElevation(dp(8));
        android.util.TypedValue fabOut=new android.util.TypedValue();getTheme().resolveAttribute(android.R.attr.selectableItemBackground,fabOut,true);
        android.graphics.drawable.Drawable fabRipple=getDrawable(fabOut.resourceId);
        if(fabRipple!=null)fab.setForeground(fabRipple);
        content.addView(fab,flp);
        final int[] downXY={-1,-1};
        fab.setOnTouchListener(new View.OnTouchListener(){
            private boolean drag;
            public boolean onTouch(View v,MotionEvent ev){
                if(ev.getAction()==MotionEvent.ACTION_DOWN){drag=false;downXY[0]=(int)ev.getRawX();downXY[1]=(int)ev.getRawY();}
                else if(ev.getAction()==MotionEvent.ACTION_MOVE){
                    float ddx=ev.getRawX()-downXY[0],ddy=ev.getRawY()-downXY[1];
                    if(Math.abs(ddx)+Math.abs(ddy)>10)drag=true;
                    if(drag){
                        FrameLayout.LayoutParams lp=(FrameLayout.LayoutParams)fab.getLayoutParams();
                        int cw=content.getWidth(),ch=content.getHeight();
                        lp.gravity=Gravity.LEFT|Gravity.TOP;
                        if(cw>0){float nx=fab.getLeft()+ddx;if(nx<0)nx=0;if(nx>cw-fab.getWidth())nx=cw-fab.getWidth();lp.leftMargin=(int)nx;}
                        if(ch>0){float ny=fab.getTop()+ddy;if(ny<0)ny=0;if(ny>ch-fab.getHeight())ny=ch-fab.getHeight();lp.topMargin=(int)ny;}
                        fab.setLayoutParams(lp);
                    }
                }
                else if(ev.getAction()==MotionEvent.ACTION_UP){
                    if(drag){FrameLayout.LayoutParams lp=(FrameLayout.LayoutParams)fab.getLayoutParams();getPreferences(0).edit().putInt("fab_x",lp.leftMargin).putInt("fab_y",lp.topMargin).apply();}
                    else{fab.performClick();}
                }
                return true;
            }
        });
        fab.setOnClickListener(v->{if(recorder!=null)stopRecording();else{page="측정";render();startRecording();}});
        fab.setOnLongClickListener(v->{showMessageDialog("녹음 버튼","버튼을 끌어 원하는 위치로 옮길 수 있어요.",true);return true;});
        if(fx>0||fy>0)content.post(()->{
            int maxX=Math.max(0,content.getWidth()-fab.getWidth()),maxY=Math.max(0,content.getHeight()-fab.getHeight());
            FrameLayout.LayoutParams lp=(FrameLayout.LayoutParams)fab.getLayoutParams();
            if(fx>maxX||fy>maxY||(fx==0&&fy>=maxY-dp(5))){lp.gravity=Gravity.RIGHT|Gravity.BOTTOM;lp.leftMargin=0;lp.topMargin=0;lp.setMargins(0,0,dp(18),dp(16));fab.setLayoutParams(lp);getPreferences(0).edit().remove("fab_x").remove("fab_y").apply();}
            else{lp.gravity=Gravity.LEFT|Gravity.TOP;lp.leftMargin=Math.max(0,Math.min(fx,maxX));lp.topMargin=Math.max(0,Math.min(fy,maxY));fab.setLayoutParams(lp);getPreferences(0).edit().putInt("fab_x",lp.leftMargin).putInt("fab_y",lp.topMargin).apply();}
        });
        switch(page){case "측정":case "소음측정":showMeasure();break;case "기록":case "소음기록":showLogs();break;case "제출양식":showForms();break;case "안내":case "층간소음안내":showInfo();break;case "층간소음보고서":showReports();break;case "내 정보":showProfile();break;case "계정":showAccount();break;case "회원가입":showSignup();break;case "아이디 찾기":showFindId();break;case "비밀번호 재설정":showPasswordReset();break;case "분석":showAnalysis();break;default:showHome();}
    }
    private final class MenuIcon extends View{
        private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        MenuIcon(Context c){super(c);setContentDescription("메뉴 열기");setClickable(true);setFocusable(true);setBackground(menuRipple());}
        private android.graphics.drawable.Drawable menuRipple(){android.util.TypedValue out=new android.util.TypedValue();getTheme().resolveAttribute(android.R.attr.selectableItemBackground,out,true);return out.resourceId==0?null:getDrawable(out.resourceId);}
        @Override protected void onMeasure(int widthMeasureSpec,int heightMeasureSpec){int size=dp(48);setMeasuredDimension(size,size);}
        @Override protected void onDraw(Canvas canvas){super.onDraw(canvas);float cx=getWidth()/2f,cy=getHeight()/2f,half=dp(11);paint.setColor(INK);paint.setStrokeWidth(dp(2));paint.setStrokeCap(Paint.Cap.ROUND);for(int i=-1;i<=1;i++){float y=cy+i*dp(6);canvas.drawLine(cx-half,y,cx+half,y,paint);}}
    }
    private final class RFab extends View{
        private final Paint p=new Paint(Paint.ANTI_ALIAS_FLAG);private boolean recording;
        RFab(Context c){super(c);setLayerType(View.LAYER_TYPE_SOFTWARE,null);}
        void setRecording(boolean active){if(recording!=active){recording=active;invalidate();}}
        @Override protected void onDraw(Canvas cv){
            super.onDraw(cv);
            float w=getWidth(),h=getHeight(),cx=w/2f,cy=h/2f,r=Math.min(w,h)*.48f;
            p.setStyle(Paint.Style.FILL);p.setColor(recording?Color.rgb(197,65,65):BLUE);cv.drawCircle(cx,cy,r,p);
            p.setColor(Color.WHITE);p.setStrokeWidth(Math.max(dp(3),r*.13f));p.setStrokeCap(Paint.Cap.ROUND);p.setStrokeJoin(Paint.Join.ROUND);
            if(recording){float s=r*.48f;cv.drawRoundRect(cx-s,cy-s,cx+s,cy+s,dp(3),dp(3),p);}
            else{
                p.setStyle(Paint.Style.STROKE);
                float mw=r*.34f,mh=r*.68f,top=cy-mh*.58f;
                cv.drawRoundRect(cx-mw/2,top,cx+mw/2,top+mh*.68f,mw/2,mw/2,p);
                cv.drawArc(cx-mw*.95f,top+mh*.2f,cx+mw*.95f,top+mh*.95f,0,180,false,p);
                cv.drawLine(cx,top+mh*.95f,cx,top+mh*1.18f,p);
                cv.drawLine(cx-r*.27f,top+mh*1.18f,cx+r*.27f,top+mh*1.18f,p);
                p.setStyle(Paint.Style.FILL);
            }
        }
    }
    private java.util.TreeMap<String,ArrayList<String[]>> byDate(){
        java.util.TreeMap<String,ArrayList<String[]>> by=new java.util.TreeMap<String,ArrayList<String[]>>();
        try{for(String[] d:records()){
            java.util.Calendar c=java.util.Calendar.getInstance();
            c.setTimeInMillis(Long.parseLong(d[2]));
            String k=String.format(Locale.KOREA,"%04d-%02d-%02d",c.get(java.util.Calendar.YEAR),c.get(java.util.Calendar.MONTH)+1,c.get(java.util.Calendar.DAY_OF_MONTH));
            if(!by.containsKey(k))by.put(k,new ArrayList<String[]>());by.get(k).add(d);
        }}catch(Exception ignored){}
        return by;
    }
    private void showMeasurementCalendar(){
        showCalendarAt(java.util.Calendar.getInstance());
    }
    private void showCalendarAt(java.util.Calendar cal){
        final java.util.TreeMap<String,ArrayList<String[]>> by=byDate();
        showCustomDialog(new SimpleDateFormat("yyyy년 M월").format(cal.getTime()),buildMonth(cal,by),null,"닫기",false,null,null);
    }
    private LinearLayout buildMonth(java.util.Calendar cal, java.util.TreeMap<String,ArrayList<String[]>> by){
        LinearLayout box=column();pad(box,4,0,4,6);
        LinearLayout nav=row();
        nav.addView(button("‹","이전 달",false,()->{java.util.Calendar n=(java.util.Calendar)cal.clone();n.add(java.util.Calendar.MONTH,-1);showCalendarAt(n);}),new LinearLayout.LayoutParams(0,-2,1));
        nav.addView(button("다음 달","›",false,()->{java.util.Calendar n=(java.util.Calendar)cal.clone();n.add(java.util.Calendar.MONTH,1);showCalendarAt(n);}),new LinearLayout.LayoutParams(0,-2,1));
        box.addView(nav);gap(box,4);
        LinearLayout wd=row();for(String s:new String[]{"일","월","화","수","목","금","토"}){TextView t=text(s,12,MUTED,false);t.setGravity(Gravity.CENTER);wd.addView(t,new LinearLayout.LayoutParams(0,-2,1));}box.addView(wd);gap(box,4);
        java.util.Calendar first=java.util.Calendar.getInstance();first.clear();first.set(java.util.Calendar.YEAR,cal.get(java.util.Calendar.YEAR));first.set(java.util.Calendar.MONTH,cal.get(java.util.Calendar.MONTH));first.set(java.util.Calendar.DAY_OF_MONTH,1);
        int lead=(first.get(java.util.Calendar.DAY_OF_WEEK)-1+7)%7;
        java.util.Calendar last=java.util.Calendar.getInstance();last.clear();last.set(java.util.Calendar.YEAR,cal.get(java.util.Calendar.YEAR));last.set(java.util.Calendar.MONTH,cal.get(java.util.Calendar.MONTH)+1);last.set(java.util.Calendar.DAY_OF_MONTH,1);last.add(java.util.Calendar.DAY_OF_MONTH,-1);
        int rows=(lead+(int)last.getActualMaximum(java.util.Calendar.DAY_OF_MONTH)+6)/7;
        java.util.Calendar day=first;day.add(java.util.Calendar.DAY_OF_MONTH,-lead);
        for(int r=0;r<rows;r++){
            LinearLayout r2=row();
            for(int c=0;c<7;c++){
                boolean other=day.get(java.util.Calendar.YEAR)!=cal.get(java.util.Calendar.YEAR)||day.get(java.util.Calendar.MONTH)!=cal.get(java.util.Calendar.MONTH);
                int dd=day.get(java.util.Calendar.DAY_OF_MONTH);
                String key=String.format(Locale.KOREA,"%04d-%02d-%02d",day.get(java.util.Calendar.YEAR),day.get(java.util.Calendar.MONTH)+1,dd);
                int n=0;if(by.containsKey(key))n=by.get(key).size();
                LinearLayout cell=column();cell.setGravity(Gravity.CENTER);cell.setClickable(!other);cell.setFocusable(!other);cell.setPadding(dp(1),dp(2),dp(1),dp(2));
                GradientDrawable cellBg=new GradientDrawable();cellBg.setCornerRadius(dp(10));cellBg.setColor(other?Color.TRANSPARENT:(n>0?SAGE:PAPER));if(!other)cellBg.setStroke(dp(1),n>0?BLUE:BORDER);cell.setBackground(cellBg);
                TextView number=text(String.valueOf(dd),14,other?MUTED:(n>0?BLUE:INK),true);number.setGravity(Gravity.CENTER);cell.addView(number,new LinearLayout.LayoutParams(-1,0,1));
                TextView count=text(n>0?n+"건":" ",9,n>0?BLUE:MUTED,true);count.setGravity(Gravity.CENTER);cell.addView(count,new LinearLayout.LayoutParams(-1,dp(12)));
                if(!other){final String kk=key;cell.setOnClickListener(w->openDay(kk));}
                LinearLayout.LayoutParams cellLp=new LinearLayout.LayoutParams(0,dp(46),1);cellLp.setMargins(dp(1),dp(1),dp(1),dp(1));r2.addView(cell,cellLp);
                day.add(java.util.Calendar.DAY_OF_MONTH,1);
            }
            box.addView(r2);
        }
        gap(box,7);LinearLayout legend=row();TextView has=text("● 기록 있음",11,BLUE,true);TextView none=text("○ 기록 없음",11,MUTED,false);legend.addView(has,new LinearLayout.LayoutParams(0,-2,1));legend.addView(none,new LinearLayout.LayoutParams(0,-2,1));box.addView(legend);gap(box,3);box.addView(text("날짜를 누르면 해당 일자의 측정 기록을 확인할 수 있어요.",11,MUTED,false));
        return box;
    }
    private void openDay(String key){
        java.util.TreeMap<String,ArrayList<String[]>> by=byDate();
        ArrayList<String[]> recs=by.get(key);
        if(recs==null||recs.isEmpty()){showMessageDialog("기록 없음","이날에는 기록된 소음 측정이 없어요.",true);return;}
        LinearLayout box=column();box.addView(text(key.replace("-",".")+" · "+recs.size()+"건",14,INK,true));gap(box,8);
        for(String[] d:recs){
            java.util.Calendar c=java.util.Calendar.getInstance();
            c.setTimeInMillis(Long.parseLong(d[2]));
            String tm=String.format(Locale.KOREA,"%02d:%02d",c.get(java.util.Calendar.HOUR_OF_DAY),c.get(java.util.Calendar.MINUTE));
            TextView row=text(tm+" · "+(d[4].isEmpty()?"종류 미입력":d[4])+(d[5].isEmpty()?"":" · "+d[5]),13,INK,true);
            row.setContentDescription("녹음 분석 결과 보기");row.setClickable(true);row.setFocusable(true);
            final String rid=d[0];row.setOnClickListener(w->{analysisId=rid;page="분석";render();});
            box.addView(row);
            if(!d[6].isEmpty()){box.addView(text(d[6],11,MUTED,false));}
            gap(box,6);
        }
        showCustomDialog(key.replace("-",".")+" · "+recs.size()+"건",box,"닫기",null,false,null,null);
    }
    private void showForms(){
        title("제출양식","필요한 양식을 열어 미리보고, PDF를 내려받거나 공유할 수 있어요.");
        for(FormDocuments.Form form:FormDocuments.ALL){
            LinearLayout item=column();item.addView(text(form.title,17,INK,true));gap(item,5);TextView filename=text(form.filename,11,MUTED,false);filename.setMaxLines(2);item.addView(filename);gap(item,10);item.addView(button("▤","PDF 미리보기",true,()->showFormPreview(form)));card(body,item);
        }
    }

    private void showFormPreview(FormDocuments.Form form){
        PdfRenderer renderer=null;ParcelFileDescriptor descriptor=null;
        try{
            File file=FormDocuments.materialize(this,form);descriptor=ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY);renderer=new PdfRenderer(descriptor);
            LinearLayout shell=column();GradientDrawable bg=new GradientDrawable();bg.setColor(Color.WHITE);bg.setCornerRadius(dp(18));shell.setBackground(bg);pad(shell,14,14,14,12);
            LinearLayout heading=row();TextView title=text(form.title,17,INK,true);title.setMaxLines(2);heading.addView(title,new LinearLayout.LayoutParams(0,-2,1));TextView close=text("닫기",13,BLUE,true);close.setGravity(Gravity.CENTER);close.setPadding(dp(12),dp(10),dp(6),dp(10));heading.addView(close);shell.addView(heading);
            gap(shell,8);LinearLayout actions=row();actions.addView(button("⬇","다운로드",false,()->downloadForm(form)),new LinearLayout.LayoutParams(0,-2,1));actions.addView(button("↗","공유",true,()->shareForm(form)),new LinearLayout.LayoutParams(0,-2,1));shell.addView(actions);gap(shell,8);
            ScrollView pages=new ScrollView(this);pages.setFillViewport(true);LinearLayout pageColumn=column();pageColumn.setBackgroundColor(Color.rgb(238,241,244));pad(pageColumn,8,8,8,8);
            int targetWidth=Math.max(dp(240),Math.min(1200,getResources().getDisplayMetrics().widthPixels-dp(64)));
            for(int i=0;i<renderer.getPageCount();i++){
                PdfRenderer.Page page=renderer.openPage(i);int width=targetWidth;int height=Math.max(1,Math.round(width*(float)page.getHeight()/page.getWidth()));Bitmap bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888);bitmap.eraseColor(Color.WHITE);page.render(bitmap,null,null,PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);page.close();
                ImageView image=new ImageView(this);image.setImageBitmap(bitmap);image.setAdjustViewBounds(true);image.setScaleType(ImageView.ScaleType.FIT_CENTER);image.setBackgroundColor(Color.WHITE);image.setElevation(dp(2));LinearLayout.LayoutParams imageLp=new LinearLayout.LayoutParams(-1,-2);imageLp.bottomMargin=dp(10);pageColumn.addView(image,imageLp);
            }
            pages.addView(pageColumn);shell.addView(pages,new LinearLayout.LayoutParams(-1,0,1));
            Dialog dialog=new Dialog(this);dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);dialog.setContentView(shell);dialog.setCanceledOnTouchOutside(true);close.setOnClickListener(v->dialog.dismiss());dialog.show();Window window=dialog.getWindow();if(window!=null){window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);WindowManager.LayoutParams lp=window.getAttributes();lp.width=Math.min(dp(700),getResources().getDisplayMetrics().widthPixels-dp(24));lp.height=getResources().getDisplayMetrics().heightPixels-dp(80);lp.gravity=Gravity.CENTER;lp.dimAmount=.45f;window.setAttributes(lp);}
        }catch(Exception e){showMessageDialog("PDF를 열지 못했습니다","양식 미리보기를 불러오지 못했습니다. 다시 시도해 주세요.",false);}
        finally{if(renderer!=null)try{renderer.close();}catch(Exception ignored){}else if(descriptor!=null)try{descriptor.close();}catch(Exception ignored){}}
    }

    private void downloadForm(FormDocuments.Form form){
        pendingFormDownloadId=form.id;Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("application/pdf");intent.putExtra(Intent.EXTRA_TITLE,form.filename);
        try{startActivityForResult(intent,REQUEST_FORM_DOWNLOAD);}catch(Exception e){pendingFormDownloadId="";showMessageDialog("저장 위치를 열지 못했습니다","기기에서 PDF를 저장할 위치를 선택할 수 없습니다.",false);}
    }

    private void shareForm(FormDocuments.Form form){
        try{Uri uri=FormDocuments.contentUri(form);Intent send=new Intent(Intent.ACTION_SEND);send.setType("application/pdf");send.putExtra(Intent.EXTRA_STREAM,uri);send.setClipData(ClipData.newUri(getContentResolver(),form.filename,uri));send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivity(Intent.createChooser(send,"양식 PDF 공유"));}
        catch(Exception e){showMessageDialog("공유할 수 없습니다","PDF 공유 화면을 열지 못했습니다.",false);}
    }

    private void title(String title,String desc){body.addView(text(title,24,INK,true));gap(body,5);TextView subtitle=text(desc,14,MUTED,false);subtitle.setLineSpacing(dp(2),1f);body.addView(subtitle);gap(body,16);}

    private void showMenuDrawer(){
        Dialog dialog=new Dialog(this);dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        FrameLayout backdrop=new FrameLayout(this);View scrim=new View(this);scrim.setBackgroundColor(Color.argb(155,0,0,0));scrim.setAlpha(0f);backdrop.addView(scrim,new FrameLayout.LayoutParams(-1,-1));
        int drawerWidth=Math.min(dp(320),getResources().getDisplayMetrics().widthPixels-dp(52));
        LinearLayout drawer=column();GradientDrawable panelBg=new GradientDrawable();panelBg.setColor(PAPER);panelBg.setCornerRadii(new float[]{0,0,dp(24),dp(24),dp(24),dp(24),0,0});drawer.setBackground(panelBg);drawer.setElevation(dp(8));pad(drawer,16,18,16,18);
        LinearLayout heading=row();heading.addView(text("메뉴",21,INK,true),new LinearLayout.LayoutParams(0,-2,1));TextView close=text("✕",19,MUTED,true);close.setGravity(Gravity.CENTER);close.setContentDescription("메뉴 닫기");close.setClickable(true);close.setFocusable(true);close.setPadding(dp(14),dp(10),dp(8),dp(10));heading.addView(close);drawer.addView(heading);gap(drawer,20);
        for(int i=0;i<tabs.length;i++){String item=tabs[i];boolean selected=item.equals(page);LinearLayout entry=row();entry.setPadding(dp(12),0,dp(12),0);entry.setMinimumHeight(dp(54));entry.setClickable(true);entry.setFocusable(true);GradientDrawable rowBg=new GradientDrawable();rowBg.setColor(selected?SAGE:Color.TRANSPARENT);rowBg.setCornerRadius(dp(14));entry.setBackground(rowBg);entry.addView(new MenuNavIcon(this,i,selected),new LinearLayout.LayoutParams(dp(24),dp(24)));TextView label=text(item,15,selected?BLUE:INK,true);pad(label,dp(14),0,0,0);entry.addView(label);LinearLayout.LayoutParams rowLp=new LinearLayout.LayoutParams(-1,-2);rowLp.bottomMargin=dp(4);drawer.addView(entry,rowLp);entry.setContentDescription(item);entry.setOnClickListener(v->{page=item;drawer.animate().translationX(-drawerWidth).setDuration(220).withEndAction(()->{dialog.dismiss();render();}).start();});}
        FrameLayout.LayoutParams drawerLp=new FrameLayout.LayoutParams(drawerWidth,-1,Gravity.LEFT|Gravity.TOP);backdrop.addView(drawer,drawerLp);drawer.setTranslationX(-drawerWidth);drawer.setClickable(true);
        dialog.setContentView(backdrop);dialog.setCancelable(true);dialog.setCanceledOnTouchOutside(false);dialog.show();Window window=dialog.getWindow();if(window!=null){window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));window.setLayout(WindowManager.LayoutParams.MATCH_PARENT,WindowManager.LayoutParams.MATCH_PARENT);window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);window.setGravity(Gravity.LEFT|Gravity.TOP);}
        scrim.setOnClickListener(v->{drawer.animate().translationX(-drawerWidth).setDuration(200).withEndAction(dialog::dismiss).start();});close.setOnClickListener(v->{drawer.animate().translationX(-drawerWidth).setDuration(200).withEndAction(dialog::dismiss).start();});
        drawer.post(()->{scrim.animate().alpha(1f).setDuration(180).start();drawer.animate().translationX(0).setDuration(240).start();});
    }
    private String apiBaseUrl(){String value=getPreferences(0).getString("api_base_url",DEFAULT_API_BASE_URL).trim();while(value.endsWith("/"))value=value.substring(0,value.length()-1);return value;}
    private void apiRequest(String method,String path,JSONObject payload,boolean authenticated,ApiCallback callback){
        final String base=apiBaseUrl(),token=getPreferences(0).getString("auth_token","");
        API_EXECUTOR.execute(()->{HttpURLConnection connection=null;JSONObject result=null;String error=null;int responseStatus=-1;try{
            connection=(HttpURLConnection)new URL(base+path).openConnection();connection.setRequestMethod(method);connection.setConnectTimeout(8000);connection.setReadTimeout(12000);connection.setRequestProperty("Accept","application/json");
            if(authenticated&&!token.isEmpty())connection.setRequestProperty("Authorization","Bearer "+token);
            if(payload!=null){connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/json; charset=UTF-8");byte[] bytes=payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);connection.getOutputStream().write(bytes);}
            int status=connection.getResponseCode();responseStatus=status;InputStream stream=status>=200&&status<300?connection.getInputStream():connection.getErrorStream();ByteArrayOutputStream buffer=new ByteArrayOutputStream();if(stream!=null){byte[] chunk=new byte[4096];int count;while((count=stream.read(chunk))!=-1)buffer.write(chunk,0,count);stream.close();}
            String response=buffer.toString("UTF-8");result=response.isEmpty()?new JSONObject():new JSONObject(response);if(status<200||status>=300)error=result.optString("error","서버 요청을 처리하지 못했습니다.");
        }catch(Exception ex){error="서버에 연결할 수 없습니다. 노트북과 휴대폰이 같은 Wi-Fi에 연결되어 있는지, API 주소와 서버 실행 상태를 확인해 주세요.";}finally{if(connection!=null)connection.disconnect();}
            final JSONObject data=result;final String message=error;final int status=responseStatus;runOnUiThread(()->{if(authenticated&&status==401)handleExpiredSession();callback.onResult(data,message);});
        });
    }
    private void handleExpiredSession(){
        if(authenticationExpiryHandled)return;
        authenticationExpiryHandled=true;committeeReportSyncRunning=false;notificationsChecked=false;
        getPreferences(0).edit().remove("auth_token").apply();
        page="계정";render();
        showMessageDialog("로그인 만료","로그인 시간이 만료되었습니다. 다시 로그인하면 위원회 제출 대기 보고서를 자동으로 전송합니다.",false);
    }
    private JSONObject json(Object... pairs){JSONObject value=new JSONObject();try{for(int i=0;i+1<pairs.length;i+=2)value.put(String.valueOf(pairs[i]),pairs[i+1]);}catch(Exception ignored){}return value;}
    private void checkResidentNotifications(){
        if(notificationsChecked||getPreferences(0).getString("auth_token","").isEmpty())return;
        notificationsChecked=true;
        apiRequest("GET","/notifications?unreadOnly=true",null,true,(data,error)->{
            if(error!=null){notificationsChecked=false;handler.postDelayed(this::checkResidentNotifications,30000);return;}
            JSONArray items=data.optJSONArray("notifications");
            if(items==null||items.length()==0)return;
            LinearLayout content=column();ArrayList<Long> ids=new ArrayList<>();int shown=items.length();
            for(int i=0;i<shown;i++){
                JSONObject item=items.optJSONObject(i);if(item==null)continue;
                long id=item.optLong("notificationId",0);if(id>0)ids.add(id);
                if(i>0)gap(content,10);
                content.addView(text(item.optString("title","위원회 알림"),15,INK,true));
                TextView message=text(item.optString("message",""),13,MUTED,false);message.setLineSpacing(dp(2),1f);content.addView(message);
                String number=item.optString("recordNo","");if(!number.isEmpty())content.addView(text("발생일지 "+number,11,BLUE,true));
            }
            ScrollView scroll=new ScrollView(this);scroll.addView(content);scroll.setLayoutParams(new LinearLayout.LayoutParams(-1,Math.min(dp(420),getResources().getDisplayMetrics().heightPixels-dp(220))));
            showCustomDialog("층간소음 처리 알림",scroll,"확인",null,false,()->{
                for(Long id:ids)apiRequest("POST","/notifications/"+id+"/read",null,true,(ignored,readError)->{});
                return true;
            },null);
        });
    }
    private static final android.text.method.PasswordTransformationMethod ASTERISK_MASK =
            new android.text.method.PasswordTransformationMethod() {
        @Override public CharSequence getTransformation(CharSequence source, View view) {
            return new CharSequence() {
                @Override public int length() { return source.length(); }
                @Override public char charAt(int index) {
                    if (index < 0 || index >= length()) throw new IndexOutOfBoundsException();
                    return '*';
                }
                @Override public CharSequence subSequence(int start, int end) {
                    if (start < 0 || end < start || end > length()) throw new IndexOutOfBoundsException();
                    char[] mask = new char[end - start];
                    Arrays.fill(mask, '*');
                    return new String(mask);
                }
                @Override public String toString() { return subSequence(0, length()).toString(); }
            };
        }
    };

    private EditText authInput(LinearLayout form, String label, String hint, int inputType) {
        gap(form, 7);
        form.addView(text(label, 13, INK, true));
        EditText edit = input(hint, inputType);
        edit.setSingleLine(true);
        edit.setInputType(inputType);
        if ((inputType & InputType.TYPE_MASK_VARIATION) != InputType.TYPE_TEXT_VARIATION_PASSWORD) {
            form.addView(edit);
            return edit;
        }

        edit.setTransformationMethod(ASTERISK_MASK);
        edit.setMinHeight(dp(48));
        edit.setPaddingRelative(dp(14), dp(11), dp(50), dp(11));
        android.widget.FrameLayout field = new android.widget.FrameLayout(this);
        field.addView(edit, new android.widget.FrameLayout.LayoutParams(-1, -2));

        ImageButton toggle = new ImageButton(this);
        toggle.setBackgroundColor(Color.TRANSPARENT);
        toggle.setImageTintList(android.content.res.ColorStateList.valueOf(MUTED));
        toggle.setImageResource(R.drawable.ic_password_visible);
        toggle.setContentDescription("비밀번호 표시");
        toggle.setOnClickListener(v -> {
            int start = edit.getSelectionStart();
            int end = edit.getSelectionEnd();
            boolean reveal = edit.getTransformationMethod() == ASTERISK_MASK;
            edit.setTransformationMethod(reveal ? android.text.method.SingleLineTransformationMethod.getInstance() : ASTERISK_MASK);
            if (start >= 0 && end >= 0) edit.setSelection(start, end);
            toggle.setImageResource(reveal ? R.drawable.ic_password_hidden : R.drawable.ic_password_visible);
            toggle.setContentDescription(reveal ? "비밀번호 숨기기" : "비밀번호 표시");
        });
        field.addView(toggle, new android.widget.FrameLayout.LayoutParams(dp(48), dp(48), Gravity.END | Gravity.CENTER_VERTICAL));
        form.addView(field, new LinearLayout.LayoutParams(-1, -2));
        return edit;
    }
    private void showEmailRequested(JSONObject data){showMessageDialog("인증 요청",data.optString("message","이메일로 받은 6자리 코드를 입력해 주세요."),true);}
    private void showAccount(){
        title("계정","이메일을 인증해 회원가입하고 로그인합니다.");
        LinearLayout server=column();server.addView(text("API 서버 주소",13,INK,true));EditText url=input("http://172.30.1.14:3100/api",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);url.setSingleLine(true);url.setText(apiBaseUrl());server.addView(url);gap(server,5);server.addView(button("서버 주소 저장",false,()->{String value=url.getText().toString().trim();if(!value.startsWith("http://")&&!value.startsWith("https://")){url.setError("http:// 또는 https:// 주소를 입력해 주세요.");return;}getPreferences(0).edit().putString("api_base_url",value).apply();showMessageDialog("서버 주소 저장","API 주소를 이 기기에 저장했습니다.",true);}));card(body,server);gap(body,5);
        String token=getPreferences(0).getString("auth_token","");
        if(token.isEmpty()){LinearLayout login=column();login.addView(text("로그인",18,INK,true));gap(login,5);EditText id=authInput(login,"아이디","아이디",InputType.TYPE_CLASS_TEXT);EditText password=authInput(login,"비밀번호","비밀번호",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);CheckBox autoLogin=new CheckBox(this);autoLogin.setText("자동 로그인");autoLogin.setTextSize(14);autoLogin.setTextColor(INK);autoLogin.setChecked(getPreferences(0).getBoolean("auto_login",true));autoLogin.setOnCheckedChangeListener((v,checked)->getPreferences(0).edit().putBoolean("auto_login",checked).apply());login.addView(autoLogin);gap(login,8);login.addView(button("로그인",true,()->{String loginId=id.getText().toString().trim(),pw=password.getText().toString();apiRequest("POST","/auth/login",json("loginId",loginId,"password",pw),false,(data,error)->{if(error!=null){showMessageDialog("로그인 실패",error,false);return;}getPreferences(0).edit().putBoolean("auto_login",autoLogin.isChecked()).putString("auth_token",data.optString("token","")).putString("auth_login_id",data.optString("loginId",loginId)).putString("auth_email",data.optString("email","")).apply();JSONObject profile=data.optJSONObject("profile");saveServerProfile(profile);syncPendingRecordings();handler.postDelayed(this::syncReportedCommitteeSubmissions,1200);notificationsChecked=false;handler.postDelayed(this::checkResidentNotifications,500);page="내 정보";render();});}));gap(login,5);LinearLayout actions=row();actions.addView(button("회원가입",false,()->{page="회원가입";render();}),new LinearLayout.LayoutParams(0,-2,1));actions.addView(button("아이디 찾기",false,()->{page="아이디 찾기";render();}),new LinearLayout.LayoutParams(0,-2,1));login.addView(actions);gap(login,4);login.addView(button("비밀번호를 잊으셨나요?",false,()->{page="비밀번호 재설정";render();}));card(body,login);}
        else{LinearLayout profile=column();profile.addView(text("로그인되어 있습니다",18,INK,true));gap(profile,8);profile.addView(text("아이디: "+getPreferences(0).getString("auth_login_id",""),14,MUTED,false));profile.addView(text("이메일: "+getPreferences(0).getString("auth_email",""),14,MUTED,false));gap(profile,8);profile.addView(button("내 정보 입력 / 수정",true,()->{page="내 정보";render();}));gap(profile,5);profile.addView(button("로그아웃",false,()->logout()));card(body,profile);}
    }
    private void logout(){notificationsChecked=false;getPreferences(0).edit().putBoolean("auto_login",false).remove("auth_token").remove("auth_login_id").remove("auth_email").remove("signup_verify_token").remove("recovery_verify_token").apply();page="계정";render();}
    private void saveServerProfile(JSONObject profile){if(profile==null)return;android.content.SharedPreferences.Editor edit=getPreferences(0).edit();java.util.Iterator<String> keys=profile.keys();while(keys.hasNext()){String key=keys.next();if("profile_manager".equals(key)||"profile_terms".equals(key)||"profile_privacy".equals(key))edit.putBoolean(key,profile.optBoolean(key,false));else edit.putString(key,profile.optString(key,""));}edit.putBoolean("profile_saved",true).apply();}
    private boolean getBooleanPreference(String key,boolean fallback){try{return getPreferences(0).getBoolean(key,fallback);}catch(ClassCastException ignored){String value=getPreferences(0).getString(key,null);return value==null?fallback:Boolean.parseBoolean(value);}}
    private void finishSignup(JSONObject data,String login,String email){
        android.content.SharedPreferences prefs=getPreferences(0);
        android.content.SharedPreferences.Editor edit=prefs.edit().remove("signup_verify_token").remove("signup_verified_email").remove("signup_email");
        String session=data.optString("token","");
        if(session.isEmpty()){edit.apply();page="계정";render();showMessageDialog("회원가입 완료","로그인해 내 정보를 입력해 주세요.",true);return;}
        for(String key:prefs.getAll().keySet())if(key.startsWith("profile_"))edit.remove(key);
        edit.putString("auth_token",session).putString("auth_login_id",data.optString("loginId",login)).putString("auth_email",data.optString("email",email)).apply();
        notificationsChecked=false;page="내 정보";render();handler.postDelayed(this::checkResidentNotifications,500);
    }
    private void showSignup(){
        title("회원가입","먼저 이메일을 인증한 뒤 아이디와 비밀번호를 만듭니다.");
        LinearLayout form=column();EditText email=authInput(form,"이메일","이메일 주소",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);email.setText(getPreferences(0).getString("signup_email",""));EditText code=authInput(form,"이메일 인증코드","6자리 코드",InputType.TYPE_CLASS_NUMBER);String verified=getPreferences(0).getString("signup_verify_token","");boolean isVerified=!verified.isEmpty()&&email.getText().toString().trim().equals(getPreferences(0).getString("signup_verified_email",""));
        LinearLayout codeActions=row();codeActions.addView(button("인증코드 받기",false,()->{String value=email.getText().toString().trim();if(!validEmail(value)){email.setError("이메일 주소를 확인해 주세요.");return;}getPreferences(0).edit().putString("signup_email",value).apply();apiRequest("POST","/auth/email/start",json("email",value,"purpose","signup"),false,(data,error)->{if(error!=null)showMessageDialog("인증 요청 실패",error,false);else showEmailRequested(data);});}),new LinearLayout.LayoutParams(0,-2,1));codeActions.addView(button("인증 확인",false,()->{String value=email.getText().toString().trim();apiRequest("POST","/auth/email/verify",json("email",value,"purpose","signup","code",code.getText().toString().trim()),false,(data,error)->{if(error!=null){showMessageDialog("인증 실패",error,false);return;}getPreferences(0).edit().putString("signup_email",value).putString("signup_verified_email",value).putString("signup_verify_token",data.optString("verificationToken","")).apply();showMessageDialog("이메일 인증 완료","아이디와 비밀번호를 입력해 회원가입을 마무리해 주세요.",true);page="회원가입";render();});}),new LinearLayout.LayoutParams(0,-2,1));form.addView(codeActions);
        EditText id=authInput(form,"아이디","영문, 숫자, 밑줄, 하이픈 · 4~40자",InputType.TYPE_CLASS_TEXT);EditText password=authInput(form,"비밀번호","8자 이상",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);EditText confirm=authInput(form,"비밀번호 확인","비밀번호를 다시 입력",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);id.setVisibility(isVerified?View.VISIBLE:View.GONE);((View)password.getParent()).setVisibility(isVerified?View.VISIBLE:View.GONE);((View)confirm.getParent()).setVisibility(isVerified?View.VISIBLE:View.GONE);gap(form,8);form.addView(button("회원가입 완료",true,()->{String p=password.getText().toString(),c=confirm.getText().toString(),login=id.getText().toString().trim(),value=email.getText().toString().trim(),proof=getPreferences(0).getString("signup_verify_token","");if(!isVerified||proof.isEmpty()||!value.equalsIgnoreCase(getPreferences(0).getString("signup_verified_email",""))){showMessageDialog("이메일 인증 필요","이메일 인증을 먼저 완료해 주세요.",false);return;}if(!login.matches("[A-Za-z0-9_-]{4,40}")){id.setError("아이디는 영문·숫자·밑줄·하이픈 4~40자로 입력해 주세요.");return;}if(p.length()<8){password.setError("비밀번호는 8자 이상 입력해 주세요.");return;}if(!p.equals(c)){confirm.setError("비밀번호가 일치하지 않습니다.");return;}apiRequest("POST","/auth/signup",json("email",value,"loginId",login,"password",p,"passwordConfirm",c,"verificationToken",proof),false,(data,error)->{if(error!=null){showMessageDialog("회원가입 실패",error,false);return;}finishSignup(data,login,value);});}));card(body,form);body.addView(button("로그인 화면으로",false,()->{page="계정";render();}));
    }
    private void showFindId(){
        title("아이디 찾기","가입한 이메일을 인증한 뒤 아이디를 확인합니다.");LinearLayout form=column();EditText email=authInput(form,"가입 이메일","이메일 주소",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);EditText code=authInput(form,"인증코드","6자리 코드",InputType.TYPE_CLASS_NUMBER);form.addView(button("인증코드 받기",false,()->{String value=email.getText().toString().trim();if(!validEmail(value)){email.setError("이메일 주소를 확인해 주세요.");return;}apiRequest("POST","/auth/email/start",json("email",value,"purpose","find-id"),false,(data,error)->{if(error!=null)showMessageDialog("인증 요청 실패",error,false);else showEmailRequested(data);});}));gap(form,7);form.addView(button("아이디 확인",true,()->{String value=email.getText().toString().trim();apiRequest("POST","/auth/email/verify",json("email",value,"purpose","find-id","code",code.getText().toString().trim()),false,(data,error)->{if(error!=null){showMessageDialog("인증 실패",error,false);return;}apiRequest("POST","/auth/find-id",json("verificationToken",data.optString("verificationToken","")),false,(found,findError)->{if(findError!=null)showMessageDialog("아이디 조회 실패",findError,false);else showMessageDialog("아이디 찾기 완료","가입 아이디: "+found.optString("loginId",""),true);});});}));card(body,form);body.addView(button("계정 화면으로",false,()->{page="계정";render();}));
    }
    private void showPasswordReset(){
        title("비밀번호 재설정","이메일 인증을 통과하면 새 비밀번호를 설정할 수 있습니다.");LinearLayout form=column();EditText email=authInput(form,"가입 이메일","이메일 주소",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);EditText code=authInput(form,"인증코드","6자리 코드",InputType.TYPE_CLASS_NUMBER);form.addView(button("인증코드 받기",false,()->{String value=email.getText().toString().trim();if(!validEmail(value)){email.setError("이메일 주소를 확인해 주세요.");return;}apiRequest("POST","/auth/email/start",json("email",value,"purpose","reset-password"),false,(data,error)->{if(error!=null)showMessageDialog("인증 요청 실패",error,false);else showEmailRequested(data);});}));gap(form,7);EditText password=authInput(form,"새 비밀번호","8자 이상",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);EditText confirm=authInput(form,"새 비밀번호 확인","새 비밀번호를 다시 입력",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);((View)password.getParent()).setVisibility(View.GONE);((View)confirm.getParent()).setVisibility(View.GONE);form.addView(button("이메일 인증 확인",false,()->{apiRequest("POST","/auth/email/verify",json("email",email.getText().toString().trim(),"purpose","reset-password","code",code.getText().toString().trim()),false,(data,error)->{if(error!=null){showMessageDialog("인증 실패",error,false);return;}getPreferences(0).edit().putString("recovery_verify_token",data.optString("verificationToken","")).apply();((View)password.getParent()).setVisibility(View.VISIBLE);((View)confirm.getParent()).setVisibility(View.VISIBLE);showMessageDialog("인증 완료","새 비밀번호를 입력해 주세요.",true);});}));gap(form,6);form.addView(button("비밀번호 변경",true,()->{String p=password.getText().toString(),c=confirm.getText().toString(),proof=getPreferences(0).getString("recovery_verify_token","");if(proof.isEmpty()){showMessageDialog("이메일 인증 필요","이메일 인증을 먼저 완료해 주세요.",false);return;}if(p.length()<8||!p.equals(c)){confirm.setError(p.length()<8?"비밀번호는 8자 이상 입력해 주세요.":"비밀번호가 일치하지 않습니다.");return;}apiRequest("POST","/auth/password/reset",json("verificationToken",proof,"password",p,"passwordConfirm",c),false,(data,error)->{if(error!=null)showMessageDialog("변경 실패",error,false);else{getPreferences(0).edit().remove("recovery_verify_token").apply();showMessageDialog("비밀번호 변경 완료","새 비밀번호로 로그인해 주세요.",true);page="계정";render();}});}));card(body,form);body.addView(button("계정 화면으로",false,()->{page="계정";render();}));
    }
    private void showHome(){
        title("조용한 일상을 기록해요","소음이 들리는 순간을 남기고, 차분하게 상황을 정리해 보세요.");
        LinearLayout modes=row();modes.setGravity(Gravity.CENTER_VERTICAL);addMode(modes,"소음측정",true,()->{page="소음측정";render();startRecording();});addMode(modes,"소음기록",false,()->{page="소음기록";render();});addMode(modes,"안내",false,()->{page="층간소음안내";render();});body.addView(modes);gap(body,16);
        body.addView(text("바로 시작",18,INK,true));gap(body,8);
        LinearLayout hero=column();hero.addView(text("소음이 발생했나요?",17,INK,true));gap(hero,4);hero.addView(text("음원을 보관하고 발생 시간과 상황을 함께 기록합니다.",13,MUTED,false));gap(hero,12);hero.addView(button("●","소음측정 시작",true,()->{page="소음측정";render();startRecording();}));card(body,hero);
        gap(body,4);LinearLayout quick=row();quick.addView(button("≡","내 소음기록",false,()->{page="소음기록";render();}),new LinearLayout.LayoutParams(0,-2,1));quick.addView(button("▤","층간소음보고서",false,()->{page="층간소음보고서";render();}),new LinearLayout.LayoutParams(0,-2,1));body.addView(quick);gap(body,18);
        ArrayList<String[]> recent=records();body.addView(text("최근 기록",18,INK,true));gap(body,7);
        if(recent.isEmpty()){LinearLayout empty=column();empty.addView(text("아직 기록이 없습니다",14,INK,true));gap(empty,3);empty.addView(text("첫 소음측정을 시작하면 이곳에서 확인할 수 있어요.",12,MUTED,false));card(body,empty);}
        else for(int i=0;i<Math.min(2,recent.size());i++){
            String[] d=recent.get(i);LinearLayout item=row();LinearLayout info=column();
            String kind=d[4].trim().isEmpty()?(d[8].trim().isEmpty()?"소음 유형 분석 중":d[8]):d[4];
            info.addView(text(kind,14,INK,true));gap(info,3);
            String meta=new SimpleDateFormat("M월 d일 · HH:mm",Locale.KOREA).format(new Date(Long.parseLong(d[2])));
            if(!d[R_RECORD_NO].isEmpty())meta=d[R_RECORD_NO]+" · "+meta;
            info.addView(text(meta,11,MUTED,false));
            String peak="최고 데시벨 · 분석 중";
            if(!d[10].isEmpty())try{peak=String.format(Locale.KOREA,"최고 데시벨 · %.1f dBFS",Double.parseDouble(d[10]));}catch(Exception ignored){peak="최고 데시벨 · 확인 불가";}
            else if(!d[8].isEmpty())peak="최고 데시벨 · 확인 불가";
            info.addView(text(peak+"  ·  지속 "+recordingDuration(d[2],d[3]),11,BLUE,true));
            if(!d[5].isEmpty())info.addView(text(d[5],11,MUTED,false));
            item.addView(info,new LinearLayout.LayoutParams(0,-2,1));
            Button playButton=button("재생",false,()->play(d[0]));item.addView(playButton,new LinearLayout.LayoutParams(dp(88),-2));card(body,item);
        }
        gap(body,6);body.addView(button("▦","날짜별 측정 기록 보기",false,()->showMeasurementCalendar()));gap(body,16);
        body.addView(text("공동주택 기준 참고",16,INK,true));gap(body,4);LinearLayout standards=column();standards.addView(text("직접충격음  ·  주간 39 / 야간 34 dB(A)",13,INK,true));gap(standards,5);standards.addView(text("최고소음도  ·  주간 57 / 야간 52 dB(A)\n공기전달음  ·  주간 45 / 야간 40 dB(A)",12,MUTED,false));gap(standards,6);standards.addView(text("휴대폰 녹음은 공식 dB(A) 측정 결과가 아니에요.",11,MUTED,false));card(body,standards);
        if(!getPreferences(0).getBoolean("profile_saved",false)){gap(body,2);body.addView(button("♙","내 정보 입력하기",false,()->{page="내 정보";render();}));}
    }
    private void addMode(LinearLayout modes,String label,boolean selected,Runnable action){TextView chip=text(label,12,selected?Color.WHITE:INK,true);chip.setGravity(Gravity.CENTER);chip.setMinHeight(dp(43));chip.setPadding(dp(7),dp(8),dp(7),dp(8));GradientDrawable shape=new GradientDrawable();shape.setColor(selected?BLUE:CARD);shape.setCornerRadius(dp(15));if(!selected)shape.setStroke(dp(1),BORDER);chip.setBackground(shape);chip.setClickable(true);chip.setFocusable(true);chip.setOnClickListener(v->action.run());LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(0,dp(46),1);lp.setMargins(dp(3),0,dp(3),0);modes.addView(chip,lp);}

    private static final String[] FLOW_TITLES={"기록","정리","대화","상담","절차 확인","마무리"};
    private static final String[] FLOW_DESCRIPTIONS={
        "소리 나는 순간을 담고, 종류·시간·상황을 사실 위주로 남겨요.",
        "감정 대신 언제·어디서·어떤 소리였는지 차분히 정리해요.",
        "가능하면 이웃과 상황을 나누고 서로의 의견을 들어요.",
        "어려우면 관리주체나 층간소음 이웃사이센터(1661-2642) 등 창구를 이용해요.",
        "필요 시 방문상담·소음측정 등 실제 절차를 기관 안내로 확인해요.",
        "결과와 메모를 다시 정리하고, 재발하면 같은 흐름으로 이어가요."
    };

    private LinearLayout createFlowCarousel(){
        LinearLayout panel=column();panel.setGravity(Gravity.CENTER_HORIZONTAL);pad(panel,14,14,14,14);
        LinearLayout top=row();TextView counter=text("1 / 6",13,BLUE,true);top.addView(counter,new LinearLayout.LayoutParams(0,-2,1));top.addView(text("좌우로 밀어 넘기기",12,MUTED,false));panel.addView(top);gap(panel,8);
        ViewFlipper flipper=new ViewFlipper(this);flipper.setMeasureAllChildren(true);
        for(int i=0;i<FLOW_TITLES.length;i++){
            LinearLayout slide=column();slide.setGravity(Gravity.CENTER_HORIZONTAL);
            FlowIllustration illustration=new FlowIllustration(this,i);slide.addView(illustration,new LinearLayout.LayoutParams(-1,dp(190)));
            gap(slide,8);slide.addView(text((i+1)+"단계 · "+FLOW_TITLES[i],17,INK,true));gap(slide,4);
            TextView description=text(FLOW_DESCRIPTIONS[i],14,INK,true);description.setGravity(Gravity.CENTER);description.setLineSpacing(dp(2),1f);slide.addView(description,new LinearLayout.LayoutParams(-1,-2));
            flipper.addView(slide,new FrameLayout.LayoutParams(-1,-1));
        }
        panel.addView(flipper,new LinearLayout.LayoutParams(-1,dp(298)));
        TextView dots=text("●  ○  ○  ○  ○  ○",12,BLUE,true);dots.setGravity(Gravity.CENTER);panel.addView(dots);gap(panel,4);
        LinearLayout nav=row();nav.addView(button("‹","이전",false,()->showFlowPage(flipper,counter,dots,(flipper.getDisplayedChild()+FLOW_TITLES.length-1)%FLOW_TITLES.length,-1)),new LinearLayout.LayoutParams(0,-2,1));
        nav.addView(button("다음","›",false,()->showFlowPage(flipper,counter,dots,(flipper.getDisplayedChild()+1)%FLOW_TITLES.length,1)),new LinearLayout.LayoutParams(0,-2,1));panel.addView(nav);
        android.view.GestureDetector gestures=new android.view.GestureDetector(this,new android.view.GestureDetector.SimpleOnGestureListener(){
            @Override public boolean onDown(MotionEvent e){return true;}
            @Override public boolean onFling(MotionEvent start,MotionEvent end,float velocityX,float velocityY){float dx=end.getX()-start.getX();if(Math.abs(dx)<dp(44)||Math.abs(velocityX)<dp(120))return false;int current=flipper.getDisplayedChild();int next=dx<0?(current+1)%FLOW_TITLES.length:(current+FLOW_TITLES.length-1)%FLOW_TITLES.length;showFlowPage(flipper,counter,dots,next,dx<0?1:-1);return true;}
        });
        flipper.setOnTouchListener((view,event)->{gestures.onTouchEvent(event);return true;});
        return panel;
    }

    private void showFlowPage(ViewFlipper flipper,TextView counter,TextView dots,int index,int direction){
        if(index==flipper.getDisplayedChild())return;
        TranslateAnimation enter=new TranslateAnimation(Animation.RELATIVE_TO_SELF,direction>0?1f:-1f,Animation.RELATIVE_TO_SELF,0f,Animation.RELATIVE_TO_SELF,0f,Animation.RELATIVE_TO_SELF,0f);
        TranslateAnimation exit=new TranslateAnimation(Animation.RELATIVE_TO_SELF,0f,Animation.RELATIVE_TO_SELF,direction>0?-1f:1f,Animation.RELATIVE_TO_SELF,0f,Animation.RELATIVE_TO_SELF,0f);
        enter.setDuration(220);exit.setDuration(220);flipper.setInAnimation(enter);flipper.setOutAnimation(exit);flipper.setDisplayedChild(index);
        counter.setText((index+1)+" / "+FLOW_TITLES.length);StringBuilder marks=new StringBuilder();for(int i=0;i<FLOW_TITLES.length;i++){if(i>0)marks.append("  ");marks.append(i==index?"●":"○");}dots.setText(marks.toString());
    }

    private final class FlowIllustration extends View{
        private final int stage;private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        FlowIllustration(Context context,int index){super(context);stage=index;setContentDescription(""+(index+1)+"단계 "+FLOW_TITLES[index]+" 그림");}
        private void shape(Canvas c,int color,float l,float t,float r,float b,float radius){paint.setStyle(Paint.Style.FILL);paint.setColor(color);c.drawRoundRect(l,t,r,b,radius,radius,paint);}
        private void circle(Canvas c,int color,float x,float y,float radius){paint.setStyle(Paint.Style.FILL);paint.setColor(color);c.drawCircle(x,y,radius,paint);}
        private void stroke(Canvas c,int color,float width,float x1,float y1,float x2,float y2){paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(width);paint.setStrokeCap(Paint.Cap.ROUND);paint.setColor(color);c.drawLine(x1,y1,x2,y2,paint);paint.setStyle(Paint.Style.FILL);}
        private void person(Canvas c,float x,float y,int color){circle(c,color,x,y,14);shape(c,color,x-20,y+20,x+20,y+78,12);stroke(c,color,7,x-17,y+40,x-34,y+62);stroke(c,color,7,x+17,y+40,x+34,y+62);}
        @Override protected void onDraw(Canvas canvas){
            super.onDraw(canvas);float s=Math.min(getWidth()/360f,getHeight()/210f);canvas.save();canvas.translate((getWidth()-360*s)/2f,(getHeight()-210*s)/2f);canvas.scale(s,s);
            shape(canvas,stage%2==0?CREAM:SAGE,0,0,360,210,22);circle(canvas,Color.rgb(242,245,248),48,48,22);circle(canvas,Color.rgb(242,245,248),314,162,30);
            switch(stage){
                case 0: // 녹음: 스마트폰과 소리 파형
                    shape(canvas,INK,142,22,218,185,17);shape(canvas,Color.WHITE,148,30,212,173,11);shape(canvas,SAGE,157,44,203,83,8);circle(canvas,Color.rgb(197,65,65),180,62,8);
                    stroke(canvas,BLUE,4,160,111,160,132);stroke(canvas,BLUE,4,170,100,170,142);stroke(canvas,BLUE,4,180,91,180,150);stroke(canvas,BLUE,4,190,101,190,141);stroke(canvas,BLUE,4,200,111,200,131);circle(canvas,MUTED,180,161,4);
                    stroke(canvas,BLUE,4,64,106,99,106);stroke(canvas,BLUE,4,76,94,103,94);stroke(canvas,BLUE,4,260,106,296,106);stroke(canvas,BLUE,4,257,94,284,94);break;
                case 1: // 정리: 체크리스트와 메모
                    shape(canvas,BLUE,124,28,236,184,14);shape(canvas,Color.WHITE,134,40,226,177,9);shape(canvas,PEACH,159,22,201,48,7);
                    for(int i=0;i<3;i++){float y=74+i*30;shape(canvas,SAGE,148,y-9,165,y+8,5);stroke(canvas,GREEN,3,151,y,155,y+4);stroke(canvas,GREEN,3,155,y+4,162,y-4);stroke(canvas,MUTED,4,176,y-2,211,y-2);}circle(canvas,PEACH,266,135,25);stroke(canvas,BLUE,5,283,153,303,173);break;
                case 2: // 대화: 마주 보는 이웃과 대화 풍선
                    person(canvas,104,112,BLUE);person(canvas,256,112,GREEN);shape(canvas,Color.WHITE,56,31,160,72,14);shape(canvas,Color.WHITE,203,31,308,72,14);
                    stroke(canvas,BLUE,3,76,48,139,48);stroke(canvas,GREEN,3,223,48,285,48);circle(canvas,PEACH,180,111,18);stroke(canvas,INK,3,173,111,177,111);stroke(canvas,INK,3,183,111,187,111);break;
                case 3: // 상담: 아파트와 안내하는 상담자
                    shape(canvas,Color.rgb(220,232,244),44,42,133,177,8);for(int r=0;r<3;r++)for(int col=0;col<2;col++)shape(canvas,Color.WHITE,58+col*39,56+r*34,80+col*39,77+r*34,4);
                    stroke(canvas,BLUE,5,145,116,191,116);stroke(canvas,BLUE,5,180,104,194,116);stroke(canvas,BLUE,5,180,128,194,116);person(canvas,251,91,GREEN);shape(canvas,Color.WHITE,224,31,318,69,12);circle(canvas,BLUE,245,50,3);circle(canvas,BLUE,270,50,3);circle(canvas,BLUE,295,50,3);break;
                case 4: // 절차 확인: 서류와 소음 측정기
                    shape(canvas,Color.WHITE,72,29,208,183,10);shape(canvas,SAGE,88,47,192,73,7);stroke(canvas,BLUE,4,96,92,182,92);stroke(canvas,MUTED,4,96,113,168,113);stroke(canvas,MUTED,4,96,131,154,131);stroke(canvas,GREEN,4,96,151,148,151);
                    shape(canvas,INK,239,54,291,166,12);shape(canvas,SAGE,246,65,284,109,6);stroke(canvas,GREEN,3,253,97,260,86);stroke(canvas,GREEN,3,260,86,267,94);stroke(canvas,GREEN,3,267,94,278,76);circle(canvas,PEACH,265,143,7);break;
                default: // 마무리: 완료 표시와 이어지는 흐름
                    shape(canvas,Color.WHITE,105,28,224,181,12);shape(canvas,SAGE,121,48,208,73,7);stroke(canvas,MUTED,4,124,92,202,92);stroke(canvas,MUTED,4,124,109,192,109);stroke(canvas,MUTED,4,124,126,178,126);
                    circle(canvas,GREEN,254,110,38);stroke(canvas,Color.WHITE,7,236,110,250,124);stroke(canvas,Color.WHITE,7,250,124,274,94);stroke(canvas,BLUE,4,63,155,84,155);stroke(canvas,BLUE,4,75,144,63,155);stroke(canvas,BLUE,4,75,166,63,155);break;
            }
            canvas.restore();
        }
    }

    private final class MenuNavIcon extends View{
        private final int icon;private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        MenuNavIcon(Context context,int index,boolean selected){super(context);icon=index;paint.setColor(selected?BLUE:MUTED);setContentDescription(tabs[index]+" 아이콘");}
        private void line(Canvas c,float x1,float y1,float x2,float y2){paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(2);paint.setStrokeCap(Paint.Cap.ROUND);c.drawLine(x1,y1,x2,y2,paint);}
        @Override protected void onDraw(Canvas canvas){super.onDraw(canvas);canvas.save();canvas.scale(getWidth()/24f,getHeight()/24f);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(2);paint.setStrokeCap(Paint.Cap.ROUND);paint.setStrokeJoin(Paint.Join.ROUND);
            if(icon==0){android.graphics.Path roof=new android.graphics.Path();roof.moveTo(3,11);roof.lineTo(12,4);roof.lineTo(21,11);canvas.drawPath(roof,paint);canvas.drawRoundRect(5,10,19,21,2,2,paint);line(canvas,10,21,10,15);line(canvas,10,15,14,15);line(canvas,14,15,14,21);}
            else if(icon==1){canvas.drawRoundRect(9,3,15,15,3,3,paint);canvas.drawArc(6,7,18,19,0,180,false,paint);line(canvas,12,19,12,22);line(canvas,8,22,16,22);}
            else if(icon==2){canvas.drawRoundRect(4,4,20,21,2,2,paint);for(int y=9;y<=17;y+=4){canvas.drawCircle(8,y,0.7f,paint);line(canvas,11,y,17,y);}}
            else if(icon==3){android.graphics.Path sheet=new android.graphics.Path();sheet.moveTo(6,3);sheet.lineTo(15,3);sheet.lineTo(19,7);sheet.lineTo(19,21);sheet.lineTo(6,21);sheet.close();canvas.drawPath(sheet,paint);line(canvas,15,3,15,8);line(canvas,15,8,19,8);line(canvas,9,12,16,12);line(canvas,9,16,16,16);}
            else if(icon==4){canvas.drawCircle(12,12,9,paint);line(canvas,12,11,12,17);paint.setStyle(Paint.Style.FILL);canvas.drawCircle(12,7.5f,1,paint);}
            else if(icon==5){android.graphics.Path sheet=new android.graphics.Path();sheet.moveTo(5,3);sheet.lineTo(15,3);sheet.lineTo(19,7);sheet.lineTo(19,21);sheet.lineTo(5,21);sheet.close();canvas.drawPath(sheet,paint);line(canvas,15,3,15,7);line(canvas,15,7,19,7);line(canvas,8,11,10,13);line(canvas,10,13,13,10);line(canvas,14,12,17,12);line(canvas,8,17,10,19);line(canvas,10,19,13,16);line(canvas,14,18,17,18);}
            else{canvas.drawCircle(12,8,4,paint);canvas.drawArc(4,13,20,25,180,180,false,paint);}
            canvas.restore();
        }
    }

    private void showMeasure(){
        title("소음 기록","필요한 순간 녹음하고 상황을 함께 기록하세요.");
        LinearLayout box=column();box.setGravity(Gravity.CENTER);styleSurface(box,CARD,18,BORDER);pad(box,18,22,18,20);timer=text(recorder==null?"00:00":elapsed(),42,INK,true);box.addView(timer);gap(box,8);box.addView(text(recorder==null?"녹음이 시작되면 이 기기에 저장됩니다":"녹음 중 · 앱을 닫지 마세요",13,recorder==null?MUTED:GREEN,true));gap(box,16);box.addView(button(recorder==null?"●  녹음 시작":"■  녹음 종료",recorder!=null,()->{if(recorder==null)startRecording();else stopRecording();}));card(body,box);
        LinearLayout note=column();note.addView(text("기록할 때 알아두세요",16,INK,true));gap(note,8);note.addView(text("• 녹음은 본인 기기의 앱 전용 저장공간에 보관됩니다.\n• 앱 마이크 녹음은 법적 효력이 있는 공식 측정이 아닙니다.\n• 대화·급배수·동물·기계 소음 등은 법령상 층간소음 범위와 다를 수 있습니다.\n• 타인의 사생활을 침해하지 않도록 녹음에 유의하세요.",13,MUTED,false));card(body,note);
        body.addView(button("▶","저장된 기록 열기",false,()->{page="기록";render();}));
    }
    private String elapsed(){long s=(System.currentTimeMillis()-startedAt)/1000;return String.format(Locale.KOREA,"%02d:%02d",s/60,s%60);}
    private void startRecording(){if(getPreferences(0).getString("auth_token","").isEmpty()){page="계정";render();showMessageDialog("로그인이 필요합니다","소음측정 원본을 서버에 보존하고 날짜별 일련번호를 발급하려면 먼저 로그인해 주세요.",false);return;}if(Build.VERSION.SDK_INT>=23&&checkSelfPermission(Manifest.permission.RECORD_AUDIO)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},41);return;}if(Build.VERSION.SDK_INT>=23&&checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED){try{requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION},42);}catch(Exception ignored){}}place=readPlace();fetchPublicIp();try{File dir=new File(getExternalFilesDir(android.os.Environment.DIRECTORY_MUSIC),"MuteLab");if(!dir.exists())dir.mkdirs();String stamp=new SimpleDateFormat("yyyyMMdd_HHmmss",Locale.KOREA).format(new Date());activeFile=File.createTempFile("소음기록_"+stamp+"_",".m4a",dir);recorder=new MediaRecorder();recorder.setAudioSource(MediaRecorder.AudioSource.MIC);recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);recorder.setAudioEncodingBitRate(96000);recorder.setAudioSamplingRate(44100);recorder.setOutputFile(activeFile.getAbsolutePath());recorder.prepare();recorder.start();startedAt=System.currentTimeMillis();page="측정";render();handler.post(tick);}catch(Exception e){if(recorder!=null){try{recorder.release();}catch(Exception ignored){}recorder=null;}new AlertDialog.Builder(this).setMessage("녹음을 시작하지 못했습니다. 마이크 권한과 저장 공간을 확인해 주세요.").setPositiveButton("확인",null).show();}}
    private void stopRecording(){if(recorder==null)return;long start=startedAt;try{recorder.stop();}catch(Exception ignored){}recorder.release();recorder=null;handler.removeCallbacks(tick);long end=System.currentTimeMillis();File done=activeFile;String id=UUID.randomUUID().toString();String[] data=new String[ROW_MIN];Arrays.fill(data,"");data[0]=id;data[1]=done.getAbsolutePath();data[2]=String.valueOf(start);data[3]=String.valueOf(end);String[]pl=place==null?new String[4]:place;data[22]=pl[0];data[23]=pl[1];data[24]=pl[2];data[25]=pl[3];String ipv=getPreferences(0).getString("env_ip","");data[28]=ipv==null?"":ipv;getPreferences(0).edit().putString("record_"+id,packRecord(data)).apply();analysisId=id;page="분석";render();analyzeRecording(id,done,start,end);if(!getPreferences(0).getString("auth_token","").isEmpty())registerRecording(data,null);}
    @Override public void onRequestPermissionsResult(int req,String[] p,int[] g){super.onRequestPermissionsResult(req,p,g);if(req==41){if(g.length>0&&g[0]==PackageManager.PERMISSION_GRANTED)startRecording();else Toast.makeText(this,"녹음하려면 마이크 권한이 필요합니다.",Toast.LENGTH_LONG).show();}else if(req==42){if(g.length>0&&g[0]==PackageManager.PERMISSION_GRANTED)Toast.makeText(this,"위치 권한이 허용되었습니다. 다음 녹음부터 위치가 함께 기록됩니다.",Toast.LENGTH_SHORT).show();else Toast.makeText(this,"위치 권한이 없어 위치 정보는 미상으로 기록됩니다.",Toast.LENGTH_SHORT).show();}}
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data){
        super.onActivityResult(requestCode,resultCode,data);
        if(requestCode==REQUEST_FORM_DOWNLOAD){
            String id=pendingFormDownloadId;pendingFormDownloadId="";
            if(resultCode!=RESULT_OK||data==null||data.getData()==null)return;
            FormDocuments.Form form=FormDocuments.find(id);if(form==null)return;
            try{File source=FormDocuments.materialize(this,form);try(java.io.InputStream in=new java.io.FileInputStream(source);java.io.OutputStream out=getContentResolver().openOutputStream(data.getData())){if(out==null)throw new java.io.IOException("저장할 수 없습니다.");byte[] buffer=new byte[8192];int count;while((count=in.read(buffer))!=-1)out.write(buffer,0,count);}showMessageDialog("저장 완료","PDF를 선택한 위치에 저장했습니다.",true);}
            catch(Exception e){showMessageDialog("저장하지 못했습니다","PDF를 저장하지 못했습니다. 저장 위치를 확인하고 다시 시도해 주세요.",false);}
            return;
        }
        if (requestCode == REQUEST_REPORT_EXPORT) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            ArrayList<String[]> entries = reportedIncidents();
            if (entries.isEmpty()) return;
            try (java.io.OutputStream output = getContentResolver().openOutputStream(data.getData())) {
                if (output == null) throw new java.io.IOException("저장할 수 없습니다.");
                writeIncidentReportPdf(output, entries);
                showMessageDialog("PDF 저장 완료", "발생 일지 " + entries.size() + "건을 한 장의 보고서로 저장했습니다.", true);
            } catch (Exception error) {
                showMessageDialog("PDF 저장 실패", "보고서 PDF를 저장하지 못했습니다. 다시 시도해 주세요.", false);
            }
            return;
        }
        if(requestCode!=REQUEST_MANAGER_DOCUMENT||resultCode!=RESULT_OK||data==null||data.getData()==null)return;
        android.net.Uri uri=data.getData();int takeFlags=data.getFlags()&Intent.FLAG_GRANT_READ_URI_PERMISSION;try{getContentResolver().takePersistableUriPermission(uri,takeFlags);}catch(Exception ignored){}getPreferences(0).edit().putString("profile_manager_business_doc_uri",uri.toString()).apply();if(managerDocLabel!=null)managerDocLabel.setText("첨부 파일: "+documentDisplayName(uri));showMessageDialog("첨부 완료","사업자등록증 사본을 이 기기에서 관리하도록 첨부했습니다.",true);
    }
    private String documentDisplayName(android.net.Uri uri){try(android.database.Cursor c=getContentResolver().query(uri,null,null,null,null)){if(c!=null&&c.moveToFirst()){int i=c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);if(i>=0)return c.getString(i);}}catch(Exception ignored){}return uri.getLastPathSegment()==null?"선택한 파일":uri.getLastPathSegment();}
    private void pickManagerDocument(){Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("*/*");intent.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"application/pdf","image/*"});intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);try{startActivityForResult(intent,REQUEST_MANAGER_DOCUMENT);}catch(Exception e){Toast.makeText(this,"파일 선택기를 열지 못했습니다.",Toast.LENGTH_SHORT).show();}}
    private String encode(String s){try{return Base64.getEncoder().encodeToString(s.getBytes("UTF-8"));}catch(Exception e){return "";}}
    private String decode(String s){try{return new String(Base64.getDecoder().decode(s),"UTF-8");}catch(Exception e){return "";}}
    private String packRecord(String[] d){org.json.JSONArray a=new org.json.JSONArray();for(String value:d)a.put(value==null?"":value);return encode(a.toString());}
    private String[] parseRecord(String stored){String value=decode(stored);if(value.startsWith("[")){try{org.json.JSONArray a=new org.json.JSONArray(value);String[] d=new String[a.length()];for(int i=0;i<d.length;i++)d[i]=a.optString(i,"");return d;}catch(Exception ignored){}}return value.split("\\|",-1);}
    private String[] readRecording(String id) {
        String[] record = parseRecord(getPreferences(0).getString("record_" + id, ""));
        if (record.length < 8) return record;
        int oldLength = record.length;
        if (oldLength < ROW_MIN) {
            record = Arrays.copyOf(record, ROW_MIN);
            Arrays.fill(record, oldLength, ROW_MIN, "");
        }
        return record;
    }

    private File numberedAudioFile(String[] record) {
        File original = new File(record[1]);
        String number = record[R_RECORD_NO];
        if (!number.matches("[0-9]{8}_[0-9]{4}") || original.getParentFile() == null) return original;
        return new File(original.getParentFile(), number + ".m4a");
    }

    private void finalizeAudioFilename(String[] record) {
        File original = new File(record[1]);
        File numbered = numberedAudioFile(record);
        if (original.equals(numbered) || analyzingRecordings.contains(record[0])) return;
        String key = "record_" + record[0];
        if (original.isFile()) {
            if (numbered.exists()) return;
            // Persist the number first so an interrupted rename can be recovered.
            if (!getPreferences(0).edit().putString(key, packRecord(record)).commit()
                    || !original.renameTo(numbered)) return;
        } else if (!numbered.isFile()) {
            return;
        }
        record[1] = numbered.getAbsolutePath();
        getPreferences(0).edit().putString(key, packRecord(record)).apply();
    }

    private ArrayList<String[]> records() {
        ArrayList<String[]> list = new ArrayList<>();
        for (String key : getPreferences(0).getAll().keySet()) {
            if (!key.startsWith("record_")) continue;
            String[] record = readRecording(key.substring(7));
            if (record.length < ROW_MIN) continue;
            finalizeAudioFilename(record);
            if (new File(record[1]).isFile()) list.add(record);
        }
        list.sort((first, second) -> Long.compare(Long.parseLong(second[2]), Long.parseLong(first[2])));
        return list;
    }
    private String date(long ms){return new SimpleDateFormat("yyyy.MM.dd  HH:mm",Locale.KOREA).format(new Date(ms));}
    private String join(String[] values){StringBuilder b=new StringBuilder();for(int i=0;i<values.length;i++){if(i>0)b.append('|');b.append(values[i]==null?"":values[i]);}return b.toString();}
    private void syncPendingRecordings() {
        ArrayList<String[]> pending = records();
        for (int i = pending.size() - 1; i >= 0; i--) {
            String[] record = pending.get(i);
            if (record[R_RECORD_NO].isEmpty()) registerRecording(record, null);
        }
    }
    private void registerRecording(String[] record, Runnable after) {
        String id = record[0];
        List<Runnable> pending = recordingUploads.get(id);
        if (pending != null) {
            if (after != null) pending.add(after);
            return;
        }
        String token = getPreferences(0).getString("auth_token", "");
        if (token.isEmpty()) {
            if (after != null) {
                page = "계정";
                render();
                showMessageDialog("로그인이 필요합니다", "음원 원본을 등록하려면 계정에 로그인해 주세요.", false);
            }
            return;
        }
        File audio = new File(record[1]);
        if (!audio.isFile()) {
            showMessageDialog("음원 없음", "원본 녹음 파일을 찾을 수 없습니다.", false);
            return;
        }
        List<Runnable> callbacks = new ArrayList<>();
        if (after != null) callbacks.add(after);
        recordingUploads.put(id, callbacks);
        RECORDING_UPLOAD_EXECUTOR.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(apiBaseUrl() + "/recordings/audio").openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(120000);
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(audio.length());
                connection.setRequestProperty("Content-Type", "audio/mp4");
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setRequestProperty("X-Client-Record-Id", id);
                connection.setRequestProperty("X-Recording-Started-At", record[2]);
                connection.setRequestProperty("X-Recording-Ended-At", record[3]);
                byte[] buffer = new byte[32768];
                try (InputStream input = new FileInputStream(audio);
                     java.io.OutputStream output = connection.getOutputStream()) {
                    int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                }
                int status = connection.getResponseCode();
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (InputStream input = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream()) {
                    if (input != null) {
                        int count;
                        while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
                    }
                }
                JSONObject response = bytes.size() == 0 ? new JSONObject() : new JSONObject(bytes.toString("UTF-8"));
                if (status < 200 || status >= 300) {
                    throw new java.io.IOException(response.optString("error", "원본 음원을 등록하지 못했습니다."));
                }
                String number = response.optString("recordNo");
                String hash = response.optString("sha256");
                if (!number.matches("[0-9]{8}_[0-9]{4}") || hash.isEmpty()) throw new java.io.IOException("녹음 일련번호를 확인하지 못했습니다.");
                runOnUiThread(() -> {
                    recordingUploads.remove(id);
                    String[] current = readRecording(id);
                    if (current.length < ROW_MIN) return;
                    current[R_RECORD_NO] = number;
                    current[R_AUDIO_HASH] = hash;
                    getPreferences(0).edit().putString("record_" + id, packRecord(current)).apply();
                    finalizeAudioFilename(current);
                    refreshPlaybackMetadata(current);
                    if ("홈".equals(page) || "기록".equals(page) || "소음기록".equals(page)
                            || ("분석".equals(page) && id.equals(analysisId))) render();
                    if (callbacks.isEmpty()) Toast.makeText(this, "소음측정 원장 등록 완료 · " + number, Toast.LENGTH_LONG).show();
                    for (Runnable callback : callbacks) callback.run();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    recordingUploads.remove(id);
                    showMessageDialog("원본 등록 실패", error.getMessage() == null
                            ? "서버 연결과 로그인 상태를 확인해 주세요." : error.getMessage(), false);
                });
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }
    private void beginIncidentReport(String id) {
        String[] record = readRecording(id);
        if (record.length < ROW_MIN) return;
        if (getPreferences(0).getString("auth_token", "").isEmpty()) {
            page = "계정";
            render();
            showMessageDialog("로그인이 필요합니다", "층간소음 발생 일지로 저장하려면 로그인해 주세요.", false);
            return;
        }
        record[R_REPORT_STATE] = "pending";
        getPreferences(0).edit().putString("record_" + id, packRecord(record)).apply();
        if (record[R_RECORD_NO].isEmpty()) registerRecording(record, () -> editRecord(id));
        else editRecord(id);
    }
    private JSONObject incidentJournal(String[] d){JSONObject journal=new JSONObject();try{journal.put("recordNo",d[R_RECORD_NO]);journal.put("startedAt",date(Long.parseLong(d[2])));journal.put("endedAt",date(Long.parseLong(d[3])));journal.put("kind",d[4]);journal.put("place",d[5]);journal.put("impact",d[6]);journal.put("withinNoiseScope","1".equals(d[7]));journal.put("tag",d[R_TAG]);journal.put("memberName",getPreferences(0).getString("profile_name",""));journal.put("address",getPreferences(0).getString("profile_address",""));}catch(Exception ignored){}return journal;}
    private void saveIncidentJournal(String[] d){apiRequest("PUT","/recordings/"+d[R_RECORD_NO]+"/journal",json("journal",incidentJournal(d)),true,(data,error)->{if(error!=null){showMessageDialog("발생 일지 저장 실패",error,false);return;}if("pending".equals(d[R_REPORT_STATE]))verifyAndCreateReport(d);else if(isIncludedInReport(d))submitCommitteeIncident(d,d[R_AUDIO_HASH],(submitted,submitError)->{if(submitError!=null)showMessageDialog("위원회 반영 실패",submitError,false);else{markCommitteeSubmissionSynced(d);showMessageDialog("저장 완료","발생 일지와 위원회 제출 내용을 갱신했습니다.",true);}});else showMessageDialog("저장 완료","녹음 원본과 연결된 발생 일지를 서버에 암호화해 저장했습니다.",true);});}
    private JSONObject committeeDetails(String[] record){JSONObject details=new JSONObject();try{details.put("minDb",record[R_LOW_DB]);details.put("maxDb",record[R_PEAK_DB]);details.put("latitude",record[R_LAT]);details.put("longitude",record[R_LON]);details.put("ip",record[R_IP]);details.put("otherName",record[R_OTHER_NAME]);details.put("otherDong",record[R_OTHER_DONG]);details.put("otherHo",record[R_OTHER_HO]);details.put("frequency",record[R_FREQUENCY]);}catch(Exception ignored){}return details;}
    private void submitCommitteeIncident(String[] record,String clientSha256,ApiCallback callback){
        if(record==null||record.length<ROW_MIN){callback.onResult(null,"제출할 발생일지 정보를 확인할 수 없습니다.");return;}
        String recordNo=record[R_RECORD_NO];
        if(recordNo==null||!recordNo.matches("[0-9]{8}_[0-9]{4}")){callback.onResult(null,"녹음 일련번호를 확인할 수 없습니다.");return;}
        String token=getPreferences(0).getString("auth_token","");
        if(token.isEmpty()){callback.onResult(null,"로그인 정보가 만료되었습니다. 다시 로그인해 주세요.");return;}
        File audio=new File(record[1]);
        if(!audio.isFile()||audio.length()==0){callback.onResult(null,"제출할 음원 파일을 찾을 수 없습니다.");return;}
        if(audio.length()>100L*1024L*1024L){callback.onResult(null,"제출 음원은 100MB 이하여야 합니다.");return;}
        final JSONObject details=committeeDetails(record);
        API_EXECUTOR.execute(()->{
            HttpURLConnection connection=null;JSONObject artifact=null;String error=null;
            try{
                connection=(HttpURLConnection)new URL(apiBaseUrl()+"/recordings/"+recordNo+"/committee-audio").openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(120000);
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(audio.length());
                connection.setRequestProperty("Accept","application/json");
                connection.setRequestProperty("Content-Type","audio/mp4");
                connection.setRequestProperty("Authorization","Bearer "+token);
                byte[] buffer=new byte[32768];
                try(InputStream input=new FileInputStream(audio);java.io.OutputStream output=connection.getOutputStream()){
                    int count;while((count=input.read(buffer))!=-1)output.write(buffer,0,count);
                }
                int status=connection.getResponseCode();
                ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                try(InputStream input=status>=200&&status<300?connection.getInputStream():connection.getErrorStream()){
                    if(input!=null){int count;while((count=input.read(buffer))!=-1)bytes.write(buffer,0,count);}
                }
                artifact=bytes.size()==0?new JSONObject():new JSONObject(bytes.toString("UTF-8"));
                if(status<200||status>=300)error=artifact.optString("error","제출 음원을 업로드하지 못했습니다.");
                else if(artifact.optLong("artifactId",0)<=0)error="서버가 제출 음원을 등록하지 못했습니다.";
            }catch(Exception ex){error="제출 음원을 서버로 전송하지 못했습니다. 네트워크 연결을 확인해 주세요.";}
            finally{if(connection!=null)connection.disconnect();}
            final JSONObject uploaded=artifact;final String uploadError=error;
            runOnUiThread(()->{
                if(uploadError!=null){callback.onResult(uploaded,uploadError);return;}
                long artifactId=uploaded.optLong("artifactId");
                String serverSha256=uploaded.optString("sha256",clientSha256);
                apiRequest("POST","/recordings/"+recordNo+"/committee-submission",
                        json("artifactId",artifactId,"sha256",serverSha256,"details",details),true,(submitted,submitError)->{
                            if(submitError!=null){notificationsChecked=false;handler.postDelayed(this::checkResidentNotifications,500);}
                            callback.onResult(submitted,submitError);
                        });
            });
        });
    }
    private void verifyAndCreateReport(String[] record) {
        String id = record[0];
        String[] current = readRecording(id);
        if (current.length < ROW_MIN) return;
        finalizeAudioFilename(current);
        final InputStream audio;
        try {
            audio = new FileInputStream(current[1]);
        } catch (java.io.IOException error) {
            showMessageDialog("원본 검증 실패", "원본 녹음 파일을 열 수 없습니다.", false);
            return;
        }
        String number = current[R_RECORD_NO];
        new Thread(() -> {
            try (InputStream input = audio) {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] buffer = new byte[32768];
                int count;
                while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
                StringBuilder hex = new StringBuilder();
                for (byte value : digest.digest()) hex.append(String.format(Locale.US, "%02X", value));
                runOnUiThread(() -> apiRequest("POST", "/recordings/" + number + "/verify", json("sha256", hex.toString()), true, (result,error) -> {
                    if (error != null) { showMessageDialog("원본 검증 실패", error, false); return; }
                    if (!result.optBoolean("verified",false)) {
                        JSONObject notice=result.optJSONObject("notification");
                        String delivery=notice!=null&&notice.optBoolean("emailSent",false)?"앱 알림과 이메일로 안내했습니다.":"앱 알림을 등록했으며 이메일 발송 상태를 확인 중입니다.";
                        notificationsChecked=false;
                        showMessageDialog("원본이 변경됨", "등록된 음원 원본과 일치하지 않아 보고서로 이관하지 않았습니다. "+delivery, false);
                        return;
                    }
                    String[] latest = readRecording(id);
                    if (latest.length < ROW_MIN || !number.equals(latest[R_RECORD_NO])) return;
                    submitCommitteeIncident(latest,hex.toString(),(submitted,submitError)->{
                        if(submitError!=null){showMessageDialog("위원회 제출 실패",submitError,false);return;}
                        latest[R_REPORT_STATE] = "reported";
                        latest[R_REPORT_OMITTED] = "";
                        getPreferences(0).edit().putString("record_" + id, packRecord(latest)).apply();
                        markCommitteeSubmissionSynced(latest);
                        page = "층간소음보고서";
                        render();
                        showMessageDialog("보고서에 추가됨", "원본 검증을 마치고 위원회 발생일지에 제출했습니다.", true);
                    });
                }));
            } catch (Exception error) {
                runOnUiThread(() -> showMessageDialog("원본 검증 실패", "음원 해시를 계산하지 못했습니다.", false));
            }
        }).start();
    }
    private static boolean isIncludedInReport(String[] record) {
        return "reported".equals(record[R_REPORT_STATE]) && !"1".equals(record[R_REPORT_OMITTED]);
    }

    private String committeeSubmissionKey(String[] record){return COMMITTEE_SYNC_PREFIX+record[R_RECORD_NO];}
    private String committeeSubmissionFingerprint(String[] record){
        StringBuilder material=new StringBuilder();
        material.append(getPreferences(0).getString("auth_login_id","")).append('\n');
        for(int i=2;i<record.length;i++)material.append(record[i]==null?"":record[i]).append('\n');
        for(String key:new String[]{"profile_kapt_code","profile_name","profile_phone","profile_address","profile_address2"})
            material.append(getPreferences(0).getString(key,"")).append('\n');
        try{
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            byte[] hash=digest.digest(material.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex=new StringBuilder();for(byte value:hash)hex.append(String.format(Locale.US,"%02X",value));return hex.toString();
        }catch(Exception ignored){return Integer.toHexString(material.toString().hashCode());}
    }
    private boolean isCommitteeSubmissionSynced(String[] record){return isIncludedInReport(record)&&committeeSubmissionFingerprint(record).equals(getPreferences(0).getString(committeeSubmissionKey(record),""));}
    private void markCommitteeSubmissionSynced(String[] record){if(isIncludedInReport(record))getPreferences(0).edit().putString(committeeSubmissionKey(record),committeeSubmissionFingerprint(record)).apply();}
    private void clearCommitteeSubmissionSynced(String[] record){getPreferences(0).edit().remove(committeeSubmissionKey(record)).apply();}

    private void syncReportedCommitteeSubmissions(){
        if(committeeReportSyncRunning||getPreferences(0).getString("auth_token","").isEmpty())return;
        authenticationExpiryHandled=false;
        ArrayList<String[]> pending=new ArrayList<>();
        for(String[] record:reportedIncidents())if(!isCommitteeSubmissionSynced(record)&&record[R_RECORD_NO].matches("[0-9]{8}_[0-9]{4}"))pending.add(record);
        if(pending.isEmpty())return;
        committeeReportSyncRunning=true;
        syncReportedCommitteeSubmission(pending,0,0,0);
    }
    private void syncReportedCommitteeSubmission(ArrayList<String[]> pending,int index,int completed,int failed){
        if(index>=pending.size()){
            committeeReportSyncRunning=false;
            if("층간소음보고서".equals(page))render();
            if(completed>0)Toast.makeText(this,"위원회 발생일지 동기화 완료 · "+completed+"건",Toast.LENGTH_LONG).show();
            if(failed>0)Toast.makeText(this,"위원회 제출 대기 · "+failed+"건 (내 정보와 네트워크를 확인해 주세요)",Toast.LENGTH_LONG).show();
            return;
        }
        String[] candidate=pending.get(index),record=readRecording(candidate[0]);
        if(record.length<ROW_MIN||!isIncludedInReport(record)||isCommitteeSubmissionSynced(record)){
            syncReportedCommitteeSubmission(pending,index+1,completed,failed);return;
        }
        apiRequest("PUT","/recordings/"+record[R_RECORD_NO]+"/journal",json("journal",incidentJournal(record)),true,(journalResult,journalError)->{
            if(journalError!=null){syncReportedCommitteeSubmission(pending,index+1,completed,failed+1);return;}
            submitCommitteeIncident(record,record[R_AUDIO_HASH],(submitted,submitError)->{
                if(submitError==null){markCommitteeSubmissionSynced(record);syncReportedCommitteeSubmission(pending,index+1,completed+1,failed);}
                else syncReportedCommitteeSubmission(pending,index+1,completed,failed+1);
            });
        });
    }

    private void setReportOmitted(String id, boolean omitted) {
        String[] record = readRecording(id);
        if (record.length < ROW_MIN || !"reported".equals(record[R_REPORT_STATE])) return;
        if(omitted)apiRequest("DELETE","/recordings/"+record[R_RECORD_NO]+"/committee-submission",null,true,(data,error)->{if(error!=null){showMessageDialog("제출 철회 실패",error,false);return;}finishReportOmitted(record,true);});
        else submitCommitteeIncident(record,record[R_AUDIO_HASH],(data,error)->{if(error!=null){showMessageDialog("다시 제출하지 못했습니다",error,false);return;}finishReportOmitted(record,false);});
    }
    private void finishReportOmitted(String[] record,boolean omitted){record[R_REPORT_OMITTED]=omitted?"1":"";getPreferences(0).edit().putString("record_"+record[0],packRecord(record)).apply();if(omitted)clearCommitteeSubmissionSynced(record);else markCommitteeSubmissionSynced(record);render();Toast.makeText(this,omitted?"위원회 제출을 철회했습니다.":"위원회에 다시 제출했습니다.",Toast.LENGTH_SHORT).show();}

    private void toggleIncidentReport(String id) {
        String[] record = readRecording(id);
        if (record.length < ROW_MIN) return;
        if ("reported".equals(record[R_REPORT_STATE])) {
            setReportOmitted(id, isIncludedInReport(record));
        } else {
            beginIncidentReport(id);
        }
    }

    private ArrayList<String[]> reportedIncidents() {
        ArrayList<String[]> entries = records();
        for (int i = entries.size() - 1; i >= 0; i--) {
            if (!isIncludedInReport(entries.get(i))) entries.remove(i);
        }
        Collections.reverse(entries);
        return entries;
    }

    private void showReports() {
        title("층간소음보고서", "원본을 검증한 발생 일지를 한 보고서로 모아 봅니다.");
        ArrayList<String[]> entries = reportedIncidents();
        LinearLayout report = column();
        if (entries.isEmpty()) {
            report.addView(text("보고서에 포함된 발생 일지가 없습니다.", 16, INK, true));
            gap(report, 6);
            report.addView(text("소음기록에서 ‘층간소음으로 보고’를 선택하면 원본 검증 후 이 보고서에 추가됩니다.", 13, MUTED, false));
        } else {
            report.addView(text("층간소음 발생 일지 · " + entries.size() + "건", 17, INK, true));
            boolean hasPendingSubmission=false;
            for (String[] entry : entries) {
                gap(report, 10);
                View divider = new View(this);
                divider.setBackgroundColor(BORDER);
                report.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
                gap(report, 9);
                report.addView(text(reportPeriod(entry) + " · " + entry[4], 13, INK, true));
                report.addView(text("소음측정 일련번호 " + entry[R_RECORD_NO], 12, BLUE, true));
                boolean synced=isCommitteeSubmissionSynced(entry);
                report.addView(text(synced?"위원회 제출 완료":"위원회 제출 동기화 대기",12,synced?GREEN:Color.rgb(168,76,67),true));
                if(!synced)hasPendingSubmission=true;
                if (!entry[5].isEmpty()) report.addView(text("발생 추정 장소 · " + entry[5], 13, MUTED, false));
                if (!entry[6].isEmpty()) report.addView(text("피해 상황 · " + entry[6], 13, MUTED, false));
                gap(report, 6);
                report.addView(button("보고서에서 생략", false, () -> setReportOmitted(entry[0], true)));
            }
            gap(report, 14);
            report.addView(button("▤", "통합 보고서 PDF 내보내기", true, this::exportIncidentReport));
            gap(report, 6);
            report.addView(button("위원회 연락처 확인", false, this::showCommitteeContacts));
            if(hasPendingSubmission){gap(report,6);report.addView(button("위원회 제출 다시 동기화",false,this::syncReportedCommitteeSubmissions));}
        }
        card(body, report);
        gap(body, 8);
        body.addView(button("기록으로 돌아가기", false, () -> { page = "소음기록"; render(); }));
        handler.post(this::syncReportedCommitteeSubmissions);
    }

    private void showCommitteeContacts(){apiRequest("GET","/committee-contacts",null,true,(data,error)->{if(error!=null){showMessageDialog("위원회 연락처",error,false);return;}JSONArray members=data.optJSONArray("members");LinearLayout content=column();if(members==null||members.length()==0){content.addView(text("제출한 단지의 위원회 연락처가 아직 등록되지 않았습니다.",14,MUTED,false));}else for(int i=0;i<members.length();i++){JSONObject member=members.optJSONObject(i);if(member==null)continue;if(i>0){gap(content,8);View divider=new View(this);divider.setBackgroundColor(BORDER);content.addView(divider,new LinearLayout.LayoutParams(-1,dp(1)));gap(content,8);}content.addView(text(member.optString("role")+" · "+member.optString("name"),15,INK,true));content.addView(text(member.optString("mobile"),14,BLUE,false));}showCustomDialog("위원회 연락처",content,null,"닫기",false,null,null);});}

    private void exportIncidentReport() {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/pdf");
        intent.putExtra(Intent.EXTRA_TITLE, "[붙임]공통_층간소음발생일지.pdf");
        try {
            startActivityForResult(intent, REQUEST_REPORT_EXPORT);
        } catch (Exception error) {
            showMessageDialog("PDF 내보내기 실패", "저장 위치를 열지 못했습니다.", false);
        }
    }

    private String reportPeriod(String[] entry) {
        return date(Long.parseLong(entry[2])) + " ~ " + date(Long.parseLong(entry[3]))
                + " (" + recordingDuration(entry[2], entry[3]) + ")";
    }

    private static final int REPORT_FORM_ROWS = 13;

    private void writeIncidentReportPdf(java.io.OutputStream output, List<String[]> entries) throws Exception {
        File template = FormDocuments.materialize(this, FormDocuments.find("noise_incident_log"));
        android.graphics.pdf.PdfDocument pdf = new android.graphics.pdf.PdfDocument();
        try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(template, ParcelFileDescriptor.MODE_READ_ONLY);
             PdfRenderer renderer = new PdfRenderer(descriptor);
             PdfRenderer.Page form = renderer.openPage(0)) {
            int width = form.getWidth();
            int height = form.getHeight();
            Bitmap background = Bitmap.createBitmap(width * 2, height * 2, Bitmap.Config.ARGB_8888);
            try {
                background.eraseColor(Color.WHITE);
                form.render(background, null, null, PdfRenderer.Page.RENDER_MODE_FOR_PRINT);
                android.graphics.pdf.PdfDocument.Page page = pdf.startPage(
                        new android.graphics.pdf.PdfDocument.PageInfo.Builder(width, height, 1).create());
                Canvas canvas = page.getCanvas();
                canvas.drawBitmap(background, null, new Rect(0, 0, width, height), null);
                Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
                paint.setColor(Color.rgb(28, 38, 50));
                paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
                android.content.SharedPreferences profile = getPreferences(0);
                drawFormCell(canvas, paint, profile.getString("profile_name", ""),
                        width * .205f, width * .386f, height * .160f, height * .198f, 11, false);
                drawFormCell(canvas, paint, profile.getString("profile_phone", ""),
                        width * .608f, width * .895f, height * .160f, height * .198f, 11, false);
                drawFormCell(canvas, paint, (profile.getString("profile_address", "") + " "
                        + profile.getString("profile_address2", "")).trim(),
                        width * .205f, width * .895f, height * .198f, height * .236f, 11, false);

                drawIncidentRows(canvas, paint, entries, width, height);
                pdf.finishPage(page);
                pdf.writeTo(output);
            } finally {
                background.recycle();
            }
        } finally {
            pdf.close();
        }
    }

    private void drawIncidentRows(Canvas canvas, Paint paint, List<String[]> entries, int width, int height) {
        float[] columns = {width * .110f, width * .379f, width * .639f, width * .889f};
        float tableTop = height * .288f;
        float rowHeight = (height * .751f - tableTop) / REPORT_FORM_ROWS;
        for (int row = 0; row < REPORT_FORM_ROWS; row++) {
            int start = entries.size() <= REPORT_FORM_ROWS ? row : row * entries.size() / REPORT_FORM_ROWS;
            int end = entries.size() <= REPORT_FORM_ROWS ? Math.min(row + 1, entries.size())
                    : (row + 1) * entries.size() / REPORT_FORM_ROWS;
            if (start >= end) break;
            float entryHeight = (rowHeight - 2) / (end - start);
            for (int i = start; i < end; i++) {
                String[] entry = entries.get(i);
                float top = tableTop + row * rowHeight + 1 + (i - start) * entryHeight;
                float bottom = top + entryHeight;
                drawFormCell(canvas, paint, date(Long.parseLong(entry[2])),
                        columns[0], columns[1], top, bottom, 10, true);
                drawFormCell(canvas, paint, entry[4], columns[1], columns[2], top, bottom, 10, true);
                drawFormCell(canvas, paint, recordingDuration(entry[2], entry[3]),
                        columns[2], columns[3], top, bottom, 10, true);
            }
        }
    }

    private void drawFormCell(Canvas canvas, Paint paint, String value, float left, float right,
                              float top, float bottom, float maxSize, boolean center) {
        String line = value.replace('\r', ' ').replace('\n', ' ').trim();
        if (line.isEmpty()) return;
        float available = right - left - 8;
        paint.setTextSize(Math.min(maxSize, (bottom - top) * .70f));
        float measured = paint.measureText(line);
        if (measured > available) paint.setTextSize(paint.getTextSize() * available / measured);
        Paint.FontMetrics metrics = paint.getFontMetrics();
        float baseline = (top + bottom - metrics.ascent - metrics.descent) / 2;
        paint.setTextAlign(center ? Paint.Align.CENTER : Paint.Align.LEFT);
        canvas.drawText(line, center ? (left + right) / 2 : left + 4, baseline, paint);
    }

    private String[] readPlace(){
        String lat="",lon="",acc="",net="";
        try{
            LocationManager lm=(LocationManager)getSystemService(Context.LOCATION_SERVICE);
            if(lm!=null){
                net=networkLabel();
                if(checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED)return new String[]{"","","",net};
                Location gps=lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                Location viaNet=lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                Location best=null;
                if(gps!=null)best=gps;
                if(viaNet!=null&&(best==null||viaNet.getTime()>best.getTime()))best=viaNet;
                if(best!=null){
                    lat=String.format(Locale.US,"%.5f",best.getLatitude());
                    lon=String.format(Locale.US,"%.5f",best.getLongitude());
                    acc=best.hasAccuracy()?String.valueOf(Math.max(0,Math.round(best.getAccuracy()))):"0";
                }
            }
        }catch(Exception ignored){}
        return new String[]{lat,lon,acc,net};
    }

    private String networkLabel(){
        try{
            ConnectivityManager cm=(ConnectivityManager)getSystemService(Context.CONNECTIVITY_SERVICE);
            if(cm==null)return "";
            if(Build.VERSION.SDK_INT>=26){
                Network n=cm.getActiveNetwork();
                if(n==null)return "";
                NetworkCapabilities caps=cm.getNetworkCapabilities(n);
                if(caps==null)return "";
                if(caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))return "vpn";
                if(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))return "wifi";
                if(caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR))return "cellular";
                if(caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))return "ethernet";
                return "기타";
            }
            NetworkInfo info=cm.getActiveNetworkInfo();
            if(info==null)return "";
            int t=info.getType();
            // TYPE_WIFI(1)/TYPE_MOBILE(0): 상수는 최신 SDK에서 제거된 deprecated 값
            if(t==1)return "wifi";
            if(t==0)return "cellular";
            return "기타";
        }catch(Exception ignored){return "";}
    }

    private void fetchPublicIp(){
        new Thread(()->{
            HttpURLConnection c=null;
            try{
                c=(HttpURLConnection)new URL("https://api.ipify.org").openConnection();
                c.setConnectTimeout(5000);c.setReadTimeout(6000);c.setRequestProperty("Accept","text/plain");
                if(c.getResponseCode()!=200)throw new Exception("HTTP "+c.getResponseCode());
                java.io.InputStream in=c.getInputStream();java.io.ByteArrayOutputStream bo=new java.io.ByteArrayOutputStream();
                byte[] buf=new byte[256];int n;
                while((n=in.read(buf))!=-1)bo.write(buf,0,n);
                String ip=bo.toString("UTF-8").trim();
                if(!ip.isEmpty()&&ip.indexOf(' ')<0&&!ip.contains("/")&&ip.length()<64)getPreferences(0).edit().putString("env_ip",ip).apply();
            }catch(Exception ignored){}
            finally{if(c!=null)try{c.disconnect();}catch(Exception ignored){}}
        }).start();
    }

    private static String secTxt(long ms){return String.format(Locale.US,"%.1f",ms/1000.0);}
    private static String durationMinutesSeconds(long milliseconds) {
        long seconds = Math.max(0, milliseconds) / 1000;
        return seconds / 60 + "분 " + seconds % 60 + "초";
    }
    private static String recordingDuration(String startedAt,String endedAt){
        try { return durationMinutesSeconds(Long.parseLong(endedAt) - Long.parseLong(startedAt)); }
        catch (NumberFormatException ignored) { return "확인 불가"; }
    }
    private static String dbfs(double rms) {
        return String.format(Locale.US, "%.1f", 20 * Math.log10(Math.max(1, rms) / 32768.0));
    }
    private String extremeReading(String[] record, int timeIndex, int levelIndex, String label) {
        try {
            long offset = Long.parseLong(record[timeIndex]);
            long started = Long.parseLong(record[2]);
            SimpleDateFormat clock = new SimpleDateFormat("HH:mm:ss.SSS", Locale.KOREA);
            String measuredAt = clock.format(new Date(started + offset));
            String level = record[levelIndex].isEmpty() ? "" : " " + record[levelIndex] + " dBFS";
            return label + level + " · " + measuredAt + " (시작 후 " + secTxt(offset) + "초)";
        } catch (NumberFormatException ignored) {
            return label + " 구간 확인 불가";
        }
    }

    private String recordingLevels(String[] record) {
        return extremeReading(record, R_PEAK_MS, R_PEAK_DB, "최고 음량") + "\n"
                + extremeReading(record, R_LOW_MS, R_LOW_DB, "최저 음량");
    }

    private void refreshPlaybackMetadata(String[] record) {
        if (!record[0].equals(playbackRecordId)) return;
        if (playbackFilename != null) playbackFilename.setText(new File(record[1]).getName());
        if (playbackLevels != null) playbackLevels.setText(record[8].isEmpty() ? "최고·최저 음량 분석 중…" : recordingLevels(record));
    }
    private static String bucketSec(int i){return String.format(Locale.US,"%.1f",i+0.5);}
    private static String envSummary(String[] d){
        if(d==null||d.length<=25)return "";
        StringBuilder b=new StringBuilder();
        if(d[22].isEmpty()&&d[23].isEmpty())b.append("위치 미상");else b.append("위치 ").append(d[22]).append(',').append(d[23]);
        if(d.length>24&&!d[24].isEmpty())b.append(" · 정확도 약 ").append(d[24]).append("m");
        b.append(" · 네트워크 ").append(d[25].isEmpty()?"미상":d[25]);
        if(d.length>28)b.append(" · 공개 IP ").append(d[28].isEmpty()?"미상":d[28]);
        return b.toString();
    }

    private void analyzeRecording(String id,File audio,long start,long end){if(!analyzingRecordings.add(id))return;new Thread(()->{String[] result=new String[9];MediaExtractor ex=null;MediaCodec codec=null;try{
        ex=new MediaExtractor();ex.setDataSource(audio.getAbsolutePath());int track=-1;MediaFormat fmt=null;for(int i=0;i<ex.getTrackCount();i++){MediaFormat f=ex.getTrackFormat(i);String mime=f.getString(MediaFormat.KEY_MIME);if(mime!=null&&mime.startsWith("audio/")){track=i;fmt=f;break;}}if(track<0)throw new Exception("오디오 트랙 없음");
        ex.selectTrack(track);String mime=fmt.getString(MediaFormat.KEY_MIME);codec=MediaCodec.createDecoderByType(mime);codec.configure(fmt,null,null,0);codec.start();boolean inputDone=false,outputDone=false;MediaCodec.BufferInfo info=new MediaCodec.BufferInfo();double sum=0;long count=0;int peak=0,sampleRate=fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)?fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE):44100;int channels=fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)?fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT):1;long windowCount=0,shortCount=0,zeroCrossings=0;double windowSum=0,shortSum=0;int sampleChannel=0;int[] previousSample=new int[Math.max(1,channels)];boolean[] previousSeen=new boolean[Math.max(1,channels)];ArrayList<Double> bins=new ArrayList<>(),microBins=new ArrayList<>();
        while(!outputDone){if(!inputDone){int input=codec.dequeueInputBuffer(10000);if(input>=0){ByteBuffer b=codec.getInputBuffer(input);b.clear();int size=ex.readSampleData(b,0);if(size<0){codec.queueInputBuffer(input,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM);inputDone=true;}else{codec.queueInputBuffer(input,0,size,ex.getSampleTime(),0);ex.advance();}}}int output=codec.dequeueOutputBuffer(info,10000);if(output>=0){ByteBuffer b=codec.getOutputBuffer(output);if(b!=null&&info.size>0){b.order(java.nio.ByteOrder.LITTLE_ENDIAN);b.position(info.offset);b.limit(info.offset+info.size);while(b.remaining()>=2){int v=b.getShort();int ci=sampleChannel%previousSample.length;if(previousSeen[ci]&&((v<0)!=(previousSample[ci]<0)))zeroCrossings++;previousSample[ci]=v;previousSeen[ci]=true;sampleChannel=(sampleChannel+1)%previousSample.length;int a=Math.abs(v);if(a>peak)peak=a;double sq=(double)v*v;sum+=sq;count++;windowSum+=sq;windowCount++;shortSum+=sq;shortCount++;if(windowCount>=Math.max(1,sampleRate*channels)){bins.add(Math.sqrt(windowSum/windowCount));windowCount=0;windowSum=0;}if(shortCount>=Math.max(1,sampleRate*channels/10)){microBins.add(Math.sqrt(shortSum/shortCount));shortCount=0;shortSum=0;}}}if((info.flags&MediaCodec.BUFFER_FLAG_END_OF_STREAM)!=0)outputDone=true;codec.releaseOutputBuffer(output,false);}else if(output==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){MediaFormat out=codec.getOutputFormat();if(out.containsKey(MediaFormat.KEY_SAMPLE_RATE))sampleRate=out.getInteger(MediaFormat.KEY_SAMPLE_RATE);if(out.containsKey(MediaFormat.KEY_CHANNEL_COUNT)){channels=out.getInteger(MediaFormat.KEY_CHANNEL_COUNT);previousSample=new int[Math.max(1,channels)];previousSeen=new boolean[Math.max(1,channels)];sampleChannel=0;}}}
        if(windowCount>0)bins.add(Math.sqrt(windowSum/windowCount));if(shortCount>0)microBins.add(Math.sqrt(shortSum/shortCount));codec.stop();codec.release();codec=null;ex.release();ex=null;double rms=count==0?0:Math.sqrt(sum/count);double avgDb=20*Math.log10(Math.max(1,rms)/32768.0);double peakDb=20*Math.log10(Math.max(1,peak)/32768.0);double mean=0;for(Double v:microBins)mean+=v;if(!microBins.isEmpty())mean/=microBins.size();double variance=0;int bursts=0;for(Double v:microBins){variance+=(v-mean)*(v-mean);if(mean>1&&v>mean*2)bursts++;}double cv=microBins.size()<2||mean<=1?0:Math.sqrt(variance/microBins.size())/mean;double crest=peakDb-avgDb;double zcrHz=count==0?0:(sampleRate*zeroCrossings)/(2.0*count);String kind;if(rms<2)kind="유효한 소리 신호가 거의 없음";else if(bursts>=2&&crest>=12)kind="짧은 음량 피크가 반복되는 충격성 신호 후보";else if(cv>=0.65)kind="시간에 따라 크게 불규칙하게 변하는 간헐 신호 후보";else if(cv<=0.25&&crest<12)kind="레벨 변화가 비교적 적은 지속 신호 후보";else kind="혼합형 음량 변화 신호 · 원인 판단 유보";StringBuilder wave=new StringBuilder();double max=1;for(Double value:bins)if(value>max)max=value;for(int i=0;i<bins.size();i++){if(i>0)wave.append(',');wave.append((int)Math.round(100*bins.get(i)/max));}String features=String.format(Locale.US,"10분의 1초 RMS 구간=%d, 2배 이상 피크 구간=%d, RMS 변동계수=%.2f, 최고-평균 차이=%.1f dB, 영교차 주파수 근사=%.0f Hz",microBins.size(),bursts,cv,crest,zcrHz);
        int maxI=-1,minI=-1;
        for(int i=0;i<microBins.size();i++){
            if(maxI<0||microBins.get(i)>microBins.get(maxI))maxI=i;
            if(minI<0||microBins.get(i)<microBins.get(minI))minI=i;
        }
        result[5]=maxI<0?"":String.valueOf(maxI*100L);
        result[6]=minI<0?"":String.valueOf(minI*100L);
        result[7]=maxI<0?"":dbfs(microBins.get(maxI));
        result[8]=minI<0?"":dbfs(microBins.get(minI));
        result[0]=kind;result[1]=String.format(Locale.US,"%.1f",avgDb);result[2]=String.format(Locale.US,"%.1f",peakDb);result[3]=wave.toString();result[4]=features;
    }catch(Exception e){Arrays.fill(result,"");result[0]="분석할 수 없음";if(codec!=null){try{codec.release();}catch(Exception ignored){}}if(ex!=null){try{ex.release();}catch(Exception ignored){}}}
        runOnUiThread(() -> {
            analyzingRecordings.remove(id);
            String[] current = readRecording(id);
            if (current.length < ROW_MIN) return;
            for (int i = 0; i < 4; i++) current[8+i] = result[i];
            current[20] = result[4];
            current[R_PEAK_MS] = result[5];
            current[R_LOW_MS] = result[6];
            current[R_PEAK_DB] = result[7];
            current[R_LOW_DB] = result[8];
            getPreferences(0).edit().putString("record_" + id, packRecord(current)).apply();
            finalizeAudioFilename(current);
            refreshPlaybackMetadata(current);
            if (page.equals("분석") && analysisId.equals(id)) render();
        });
    }).start();}
    private void showAnalysis(){
        String[] d=readRecording(analysisId);
        title("녹음 분석 결과","녹음된 파형의 크기와 시간에 따른 변화를 요약했습니다.");
        if(d.length<12){body.addView(text("분석 정보를 찾을 수 없습니다.",14,MUTED,false));return;}
        finalizeAudioFilename(d);
        LinearLayout panel=column();
        panel.addView(text(new File(d[1]).getName(),15,INK,true));
        panel.addView(text(date(Long.parseLong(d[2]))+" 녹음 · "+recordingDuration(d[2],d[3]),14,MUTED,false));String envS=envSummary(d);if(!envS.isEmpty()){gap(panel,3);panel.addView(text("녹음 환경 · "+envS,11,MUTED,false));}gap(panel,10);
        if(d[8].isEmpty())panel.addView(text("녹음 파일을 분석하고 있습니다…",16,BLUE,true));
        else{
            panel.addView(text(d[8],21,INK,true));gap(panel,8);
            if(!d[9].isEmpty()){gap(panel,14);double avg=0,peak=0;try{avg=Math.abs(Double.parseDouble(d[9]));peak=Math.abs(Double.parseDouble(d[10]));}catch(Exception ignored){}panel.addView(text(String.format(Locale.KOREA,"평균 신호 감쇠량    +%.1f dB",avg),15,INK,true));gap(panel,4);panel.addView(text(String.format(Locale.KOREA,"최고 신호 감쇠량    +%.1f dB",peak),15,INK,true));gap(panel,5);panel.addView(text("녹음기의 최대 디지털 레벨(0 dBFS)에서 떨어진 상대값입니다. 보정된 dB(A) 소음 측정값이 아닙니다.",12,MUTED,false));if(d.length>20&&!d[20].isEmpty()){gap(panel,5);panel.addView(text("음향 특징 · "+d[20],12,MUTED,false));}
            gap(panel,8);
            panel.addView(text(recordingLevels(d),13,INK,true));
            }
            gap(panel,16);panel.addView(text("시간대별 녹음 파형(1초 단위) · 상대 크기 0–100",14,INK,true));gap(panel,8);
            final String[] bars=d[11].isEmpty()?new String[0]:d[11].split(",");View chart=new View(this){final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);final Paint label=new Paint(Paint.ANTI_ALIAS_FLAG);{paint.setStrokeWidth(dp(2.5f));paint.setStrokeCap(Paint.Cap.ROUND);label.setTextSize(dp(10));label.setTypeface(Typeface.create(Typeface.DEFAULT,Typeface.BOLD));label.setTextAlign(Paint.Align.CENTER);}@Override protected void onDraw(Canvas canvas){super.onDraw(canvas);int n=Math.min(48,bars.length);if(n==0)return;float[] values=new float[n];int maxIndex=0,minIndex=0;for(int i=0;i<n;i++){try{values[i]=Math.min(100,Math.abs(Float.parseFloat(bars[i])));}catch(Exception ignored){values[i]=0;}if(values[i]>values[maxIndex])maxIndex=i;if(values[i]<values[minIndex])minIndex=i;}if(minIndex==maxIndex&&n>1)minIndex=n-1;float base=getHeight()-dp(3),usable=getHeight()-dp(19),step=getWidth()/(float)(n+1);float mx=base-usable*Math.min(100,Math.max(0f,values[maxIndex]))/100f,ln=base-usable*Math.min(100,Math.max(0f,values[minIndex]))/100f;paint.setColor(Color.rgb(224,86,64));canvas.drawLine(step*(maxIndex+1),base,step*(maxIndex+1),mx,paint);paint.setColor(Color.rgb(34,153,119));canvas.drawLine(step*(minIndex+1),base,step*(minIndex+1),ln,paint);for(int i=0;i<n;i++){float h=Math.max(dp(2),usable*values[i]/100f);paint.setColor(i==maxIndex?Color.rgb(224,86,64):(i==minIndex?Color.rgb(34,153,119):Color.rgb(73,143,205)));canvas.drawLine(step*(i+1),base,step*(i+1),base-h,paint);}float mxT=step*(maxIndex+1),lmT=step*(minIndex+1);String maxL="최고 "+Math.round(values[maxIndex])+" · ≈"+bucketSec(maxIndex)+"초",minL="최저 "+Math.round(values[minIndex])+" · ≈"+bucketSec(minIndex)+"초";label.setColor(Color.rgb(224,86,64));float maxY=Math.max(dp(10),base-usable*values[maxIndex]/100f-dp(4));float tw=label.measureText(maxL)/2f;float txx=Math.max(tw,Math.min(getWidth()-tw,mxT));canvas.drawText(maxL,txx,maxY,label);label.setColor(Color.rgb(34,153,119));float minY=Math.max(dp(10),base-usable*values[minIndex]/100f-dp(4));if(Math.abs(step*(maxIndex-minIndex))<dp(48))minY=Math.max(dp(10),minY-dp(12));float tw2=label.measureText(minL)/2f;float ty2=Math.max(tw2,Math.min(getWidth()-tw2,lmT));canvas.drawText(minL,ty2,minY,label);}};panel.addView(chart,new LinearLayout.LayoutParams(-1,dp(64)));
            LinearLayout axis=row();TextView from=text("시작  "+new SimpleDateFormat("HH:mm:ss",Locale.KOREA).format(new Date(Long.parseLong(d[2]))),11,MUTED,false);TextView to=text("종료  "+new SimpleDateFormat("HH:mm:ss",Locale.KOREA).format(new Date(Long.parseLong(d[3]))),11,MUTED,false);axis.addView(from,new LinearLayout.LayoutParams(0,-2,1));to.setGravity(Gravity.END);axis.addView(to,new LinearLayout.LayoutParams(0,-2,1));gap(panel,7);panel.addView(axis);
        }
        card(body,panel);gap(body,4);body.addView(button("✎","소음 발생 일지 작성",true,()->editRecord(analysisId)));gap(body,4);body.addView(button("↩","기록 목록으로",false,()->{page="기록";render();}));
    }
    private void showLogs(){title("내 소음 기록","음원은 서버에 원본 해시와 함께 등록하고, 발생 일지는 해당 측정 건과 연결합니다.");ArrayList<String[]> list=records();if(list.isEmpty()){LinearLayout empty=column();empty.setGravity(Gravity.CENTER);empty.addView(text("아직 저장된 기록이 없어요",16,INK,true));gap(empty,8);empty.addView(text("소음이 발생하면 우하단 Record 버튼을 눌러 보세요.",13,MUTED,false));card(body,empty);return;}for(String[] d:list){LinearLayout c=column();c.addView(text(date(Long.parseLong(d[2])),16,INK,true));gap(c,5);c.addView(text(d[R_RECORD_NO].isEmpty()?new File(d[1]).getName():"소음측정 일련번호 · "+d[R_RECORD_NO],11,d[R_RECORD_NO].isEmpty()?MUTED:BLUE,true));String envL=envSummary(d);if(!envL.isEmpty()){gap(c,3);c.addView(text("녹음 환경 · "+envL,11,MUTED,false));}if(!d[4].isEmpty()){gap(c,6);c.addView(text("종류: "+d[4]+(d[5].isEmpty()?"":" · 장소: "+d[5]),13,INK,false));}if(!d[6].isEmpty()){gap(c,5);c.addView(text(d[6],13,MUTED,false));}gap(c,10);LinearLayout actions=row();actions.addView(button("▶","재생",false,()->play(d[0])),new LinearLayout.LayoutParams(0,-2,1));actions.addView(button("☰","분석 결과",false,()->openAnalysis(d)),new LinearLayout.LayoutParams(0,-2,1));actions.addView(button("✎","일지 작성",false,()->editRecord(d[0])),new LinearLayout.LayoutParams(0,-2,1));c.addView(actions);gap(c,4);LinearLayout more=row();more.addView(button("⚑",isIncludedInReport(d)?"층간소음보고에서 생략":"층간소음으로 보고",!isIncludedInReport(d),()->toggleIncidentReport(d[0])),new LinearLayout.LayoutParams(0,-2,2));more.addView(button("✕","삭제",false,()->deleteRecord(d)),new LinearLayout.LayoutParams(0,-2,1));c.addView(more);card(body,c);}}
    private void openAnalysis(String[] data) {
        analysisId = data[0];
        page = "분석";
        render();
        analyzeOlderRecording(readRecording(analysisId));
    }

    private void analyzeOlderRecording(String[] record) {
        if (record.length < ROW_MIN || !record[R_PEAK_DB].isEmpty() || "분석할 수 없음".equals(record[8])) return;
        File audio = new File(record[1]);
        if (audio.isFile()) analyzeRecording(record[0], audio, Long.parseLong(record[2]), Long.parseLong(record[3]));
    }
    private static final String[][] NOISE_TYPES = {
        {"뛰거나 걷는 소리", "발소리 발걸음 뜀박질 발망치 직접충격"},
        {"악기 소리", "피아노 기타 드럼 연주 공기전달"},
        {"문 여닫는 소리", "문 개폐 소리 문닫는 소리 문열리는 소리 쾅 직접충격"},
        {"물건 떨어뜨리는 소리", "낙하 물건 떨어지는 소리 직접충격"},
        {"망치질 소리", "망치소리 두드리는 소리 직접충격"},
        {"가구 끄는 소리", "의자 책상 가구 끌거나 옮기는 소리 직접충격"},
        {"가전제품 소리 (TV·음향기기 등)", "텔레비전 오디오 스피커 음악 공기전달"},
    };

    private static String noiseSearchText(String value) {
        return value.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
    }

    private void selectNoiseType(Button field, String value) {
        field.setTag(value);
        field.setText(value);
        field.setError(null);
    }

    private void showNoiseTypePicker(Button field) {
        LinearLayout content = column();
        EditText search = input("예: 발소리, 피아노, TV", InputType.TYPE_CLASS_TEXT);
        search.setSingleLine(true);
        content.addView(search);
        gap(content, 8);

        ArrayAdapter<String> options = new ArrayAdapter<>(this, android.R.layout.simple_list_item_1);
        ListView results = new ListView(this);
        results.setAdapter(options);
        content.addView(results, new LinearLayout.LayoutParams(-1, dp(232)));
        TextView empty = text("일치하는 소음 유형이 없습니다.", 13, MUTED, false);
        content.addView(empty);
        results.setEmptyView(empty);

        Dialog picker = showCustomDialog("소음 유형 검색", content, "기타 직접 입력", "닫기", false, () -> {
            EditText custom = input("소음 유형을 입력해 주세요", InputType.TYPE_CLASS_TEXT);
            custom.setSingleLine(true);
            showCustomDialog("기타 소음 유형", custom, "선택", "취소", false, () -> {
                String value = custom.getText().toString().trim();
                if (value.isEmpty()) {
                    custom.setError("소음 유형을 입력해 주세요.");
                    return false;
                }
                selectNoiseType(field, value);
                return true;
            }, null);
            return true;
        }, null);
        results.setOnItemClickListener((list, row, index, itemId) -> {
            selectNoiseType(field, options.getItem(index));
            picker.dismiss();
        });

        Runnable refresh = () -> {
            String query = noiseSearchText(search.getText().toString());
            options.setNotifyOnChange(false);
            options.clear();
            for (String[] type : NOISE_TYPES) {
                if (noiseSearchText(type[0] + " " + type[1]).contains(query)) options.add(type[0]);
            }
            options.notifyDataSetChanged();
        };
        search.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) { refresh.run(); }
            @Override public void afterTextChanged(android.text.Editable value) {}
        });
        refresh.run();
    }

    private void editRecord(String id){
        String raw=getPreferences(0).getString("record_"+id,"");String[] parsed=parseRecord(raw);if(parsed.length<8)return;final String[] d=Arrays.copyOf(parsed,Math.max(ROW_MIN,parsed.length));
        LinearLayout form=column();form.addView(text("녹음 시간",12,MUTED,true));gap(form,3);form.addView(text(date(Long.parseLong(d[2]))+"부터 "+date(Long.parseLong(d[3])),13,INK,false));gap(form,12);
        Button kind = button(d[4].isEmpty() ? "소음 유형 검색" : d[4], false, () -> {});
        kind.setTag(d[4]);
        kind.setOnClickListener(view -> showNoiseTypePicker(kind));
        form.addView(text("입주자가 판단한 소음 유형",13,INK,true));form.addView(kind);gap(form,8);
        EditText place=input("예: 102동 602호",InputType.TYPE_CLASS_TEXT);place.setText(d[5]);form.addView(text("발생 추정 장소 · 선택",13,INK,true));form.addView(place);gap(form,6);form.addView(text("'옆집','윗집' 말고 가능한 경우 정확한 동호수를 입력하세요",12,MUTED,false));gap(form,8);
        form.addView(text("상대세대 정보 · 선택",13,INK,true));
        EditText otherName=input("상대세대 입주자명",InputType.TYPE_CLASS_TEXT);otherName.setText(d[R_OTHER_NAME]);form.addView(otherName);gap(form,5);
        LinearLayout otherUnit=row();EditText otherDong=input("동",InputType.TYPE_CLASS_TEXT);otherDong.setText(d[R_OTHER_DONG]);EditText otherHo=input("호수",InputType.TYPE_CLASS_TEXT);otherHo.setText(d[R_OTHER_HO]);otherUnit.addView(otherDong,new LinearLayout.LayoutParams(0,-2,1));otherUnit.addView(otherHo,new LinearLayout.LayoutParams(0,-2,1));form.addView(otherUnit);gap(form,8);
        EditText frequency=input("예: 5분 또는 3회",InputType.TYPE_CLASS_TEXT);frequency.setText(d[R_FREQUENCY]);form.addView(text("지속시간 또는 횟수 · 선택",13,INK,true));form.addView(frequency);gap(form,8);
        EditText impact=input("피해 상황과 당시 상황을 적어 주세요",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE);impact.setMinLines(3);impact.setGravity(Gravity.TOP);impact.setText(d[6]);form.addView(text("피해 사례",13,INK,true));form.addView(impact);gap(form,8);
        EditText tag=input("예: #야간, #쿵쿵",InputType.TYPE_CLASS_TEXT);tag.setText(d[R_TAG]);form.addView(text("태그 (선택)",13,INK,true));form.addView(tag);gap(form,8);
        // '층간소음 범위' 안내 체크박스는 팝업 최하단 고정
        CheckBox relevant=new CheckBox(this);relevant.setText("층간소음 범위에 해당할 수 있다고 생각함");relevant.setTextSize(13);relevant.setChecked(d[7].equals("1"));form.addView(relevant);
        ScrollView scroll=new ScrollView(this);scroll.addView(form);showCustomDialog("소음 발생 일지 수정",scroll,"저장","취소",false,()->{String selectedKind=(String)kind.getTag();if(selectedKind.isEmpty()){kind.setError("소음 유형을 선택해 주세요.");return false;}if(impact.getText().toString().trim().isEmpty()){impact.setError("피해 상황을 입력해 주세요.");impact.requestFocus();return false;}String[] latest=readRecording(id);if(latest.length<ROW_MIN)return false;latest[4]=selectedKind;latest[5]=place.getText().toString().trim();latest[6]=impact.getText().toString().trim();latest[7]=relevant.isChecked()?"1":"0";latest[R_TAG]=tag.getText().toString().trim();latest[R_OTHER_NAME]=otherName.getText().toString().trim();latest[R_OTHER_DONG]=otherDong.getText().toString().trim().replaceAll("동$","");latest[R_OTHER_HO]=otherHo.getText().toString().trim().replaceAll("호$","");latest[R_FREQUENCY]=frequency.getText().toString().trim();for(int i=12;i<=15;i++)latest[i]="";latest[16]="";latest[17]="";latest[18]="";latest[21]="";latest[19]="1";getPreferences(0).edit().putString("record_"+id,packRecord(latest)).apply();if(!latest[R_RECORD_NO].isEmpty()){saveIncidentJournal(latest);page=page.equals("분석")?"분석":"소음기록";render();return true;}page=page.equals("분석")?"분석":"기록";render();handler.post(()->showMessageDialog("저장 완료","소음 발생 일지와 입주자 정보를 이 기기에 저장했습니다.",true));return true;},null);
    }
    private void deleteRecord(String[] d){String[] current=readRecording(d[0]);if(current.length<ROW_MIN)return;if(recordingUploads.containsKey(current[0])){showMessageDialog("원본 등록 중","등록이 끝난 뒤 다시 확인해 주세요.",false);return;}if(!current[R_RECORD_NO].isEmpty()){showMessageDialog("원본 보존","서버에 등록된 원본 음원과 일련번호는 무결성 보존을 위해 삭제할 수 없습니다.",false);return;}LinearLayout content=column();content.addView(text("이 녹음 파일과 연결된 일지를 삭제합니다. 삭제한 기록은 복구할 수 없습니다.",14,MUTED,false));showCustomDialog("녹음 기록 삭제",content,"삭제","취소",true,()->{File audio=new File(d[1]);if(audio.exists()&&!audio.delete()){showMessageDialog("삭제하지 못했습니다","녹음 파일을 삭제할 수 없습니다. 파일 접근 상태를 확인해 주세요.",false);return false;}getPreferences(0).edit().remove("record_"+d[0]).apply();page="기록";render();handler.post(()->showMessageDialog("삭제 완료","녹음 파일과 연결된 일지를 삭제했습니다.",true));return true;},null);}    private String playTime(int ms){return durationMinutesSeconds(ms);}
    private void play(String id){
        try{
            if(playbackDialog!=null)playbackDialog.dismiss();
            if(player!=null){player.release();player=null;}
            String[] record = readRecording(id);
            if (record.length < ROW_MIN) throw new java.io.IOException("녹음 파일 없음");
            finalizeAudioFilename(record);
            File audio = new File(record[1]);
            if (!audio.isFile()) throw new java.io.IOException("녹음 파일 없음");
            player = new MediaPlayer();
            player.setDataSource(audio.getAbsolutePath());
            player.prepare();
            int total=player.getDuration();
            Dialog dialog=new Dialog(this);dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
            LinearLayout shell=column();pad(shell,20,18,20,18);GradientDrawable shellBg=new GradientDrawable();shellBg.setColor(PAPER);shellBg.setCornerRadius(dp(26));shellBg.setStroke(dp(1),BORDER);shell.setBackground(shellBg);shell.setElevation(dp(10));

            LinearLayout heading=row();
            TextView note=text("♫",23,BLUE,true);note.setGravity(Gravity.CENTER);styleSurface(note,SAGE,17,BORDER);heading.addView(note,new LinearLayout.LayoutParams(dp(48),dp(48)));
            LinearLayout headingText=column();pad(headingText,12,0,0,0);headingText.addView(text("녹음 재생",19,INK,true));
            String kind=record[4].trim().isEmpty()?"소음 측정 기록":record[4];
            TextView subtitle=text(kind,12,MUTED,false);subtitle.setMaxLines(1);headingText.addView(subtitle);
            heading.addView(headingText,new LinearLayout.LayoutParams(0,-2,1));
            TextView close=text("✕",17,MUTED,true);close.setGravity(Gravity.CENTER);close.setContentDescription("재생 창 닫기");styleSurface(close,BUTTON_ALT,20,BUTTON_BORDER);heading.addView(close,new LinearLayout.LayoutParams(dp(42),dp(42)));
            shell.addView(heading);close.setOnClickListener(v->{if(playbackDialog!=null)playbackDialog.dismiss();});

            gap(shell,16);LinearLayout fileCard=column();pad(fileCard,14,12,14,12);styleSurface(fileCard,CARD,16,BORDER);
            playbackRecordId=id;playbackFilename=text(audio.getName(),14,INK,true);playbackFilename.setSingleLine(true);playbackFilename.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);fileCard.addView(playbackFilename);
            String captured=new SimpleDateFormat("yyyy년 M월 d일 · HH:mm",Locale.KOREA).format(new Date(Long.parseLong(record[2])));
            gap(fileCard,3);fileCard.addView(text(captured+"  ·  "+playTime(total),11,MUTED,false));
            gap(fileCard,8);playbackLevels=text("",12,INK,false);fileCard.addView(playbackLevels);refreshPlaybackMetadata(record);shell.addView(fileCard);

            gap(shell,20);LinearLayout statusRow=row();TextView status=text("재생 중",12,BLUE,true);statusRow.addView(status,new LinearLayout.LayoutParams(0,-2,1));statusRow.addView(pill("원본 음원"));shell.addView(statusRow);
            playbackSeek=new SeekBar(this);playbackSeek.setMax(Math.max(1,total));playbackSeek.setProgress(0);shell.addView(playbackSeek,new LinearLayout.LayoutParams(-1,dp(38)));
            LinearLayout times=row();playbackElapsed=text(playTime(0),12,INK,true);playbackTime=text(playTime(total),12,MUTED,false);times.addView(playbackElapsed,new LinearLayout.LayoutParams(0,-2,1));playbackTime.setGravity(Gravity.END);times.addView(playbackTime);shell.addView(times);

            gap(shell,18);LinearLayout controls=row();controls.setGravity(Gravity.CENTER);
            TextView back=text("↶ 10초",12,INK,true);back.setGravity(Gravity.CENTER);styleSurface(back,BUTTON_ALT,14,BUTTON_BORDER);controls.addView(back,new LinearLayout.LayoutParams(dp(84),dp(44)));
            TextView toggle=text("Ⅱ",24,Color.WHITE,true);toggle.setGravity(Gravity.CENTER);toggle.setContentDescription("일시정지");GradientDrawable toggleBg=new GradientDrawable();toggleBg.setColor(BLUE);toggleBg.setShape(GradientDrawable.OVAL);toggle.setBackground(toggleBg);toggle.setElevation(dp(3));LinearLayout.LayoutParams toggleLp=new LinearLayout.LayoutParams(dp(62),dp(62));toggleLp.setMargins(dp(22),0,dp(22),0);controls.addView(toggle,toggleLp);
            TextView forward=text("10초 ↷",12,INK,true);forward.setGravity(Gravity.CENTER);styleSurface(forward,BUTTON_ALT,14,BUTTON_BORDER);controls.addView(forward,new LinearLayout.LayoutParams(dp(84),dp(44)));shell.addView(controls);
            back.setClickable(true);back.setFocusable(true);back.setOnClickListener(v->{if(player!=null)player.seekTo(Math.max(0,player.getCurrentPosition()-10000));});
            forward.setClickable(true);forward.setFocusable(true);forward.setOnClickListener(v->{if(player!=null)player.seekTo(Math.min(player.getDuration(),player.getCurrentPosition()+10000));});
            toggle.setClickable(true);toggle.setFocusable(true);toggle.setOnClickListener(v->{if(player==null)return;if(player.isPlaying()){player.pause();toggle.setText("▶");toggle.setContentDescription("재생");status.setText("일시정지");}else{player.start();toggle.setText("Ⅱ");toggle.setContentDescription("일시정지");status.setText("재생 중");playbackTick.run();}});

            playbackDialog=dialog;dialog.setContentView(shell);dialog.setCancelable(true);dialog.setCanceledOnTouchOutside(true);
            playbackSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onProgressChanged(SeekBar s,int progress,boolean fromUser){if(fromUser&&player!=null&&playbackElapsed!=null)playbackElapsed.setText(playTime(progress));}public void onStartTrackingTouch(SeekBar s){}public void onStopTrackingTouch(SeekBar s){if(player!=null)player.seekTo(s.getProgress());}});
            dialog.setOnDismissListener(ignored->{handler.removeCallbacks(playbackTick);if(player!=null){try{if(player.isPlaying())player.stop();}catch(Exception ignoredStop){}player.release();player=null;}playbackDialog=null;playbackTime=null;playbackElapsed=null;playbackRecordId="";playbackFilename=null;playbackLevels=null;});
            player.setOnCompletionListener(p->{if(playbackDialog!=null)playbackDialog.dismiss();});
            dialog.show();Window window=dialog.getWindow();if(window!=null){window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);WindowManager.LayoutParams lp=window.getAttributes();lp.width=Math.min(dp(440),getResources().getDisplayMetrics().widthPixels-dp(36));lp.height=WindowManager.LayoutParams.WRAP_CONTENT;lp.gravity=Gravity.CENTER;lp.dimAmount=.5f;window.setAttributes(lp);}
            player.start();playbackTick.run();
            analyzeOlderRecording(record);
        }catch(Exception e){if(player!=null){try{player.release();}catch(Exception ignored){}player=null;}Toast.makeText(this,"녹음을 재생하지 못했습니다.",Toast.LENGTH_SHORT).show();}
    }
    private void infoSection(String heading,String summary,String details,String actionLabel,Runnable action){
        LinearLayout content=column();
        content.addView(text(heading,17,INK,true));
        gap(content,7);
        TextView summaryView=text(summary,14,MUTED,false);
        summaryView.setLineSpacing(dp(3),1f);
        content.addView(summaryView);
        gap(content,10);
        LinearLayout detail=column();
        detail.setVisibility(View.GONE);
        TextView detailText=text(details,13,INK,false);
        detailText.setLineSpacing(dp(4),1f);
        GradientDrawable detailBg=new GradientDrawable();detailBg.setColor(CARD);detailBg.setCornerRadius(dp(14));detailBg.setStroke(dp(1),BORDER);
        detail.setBackground(detailBg);pad(detail,13,12,13,12);detail.addView(detailText);
        if(actionLabel!=null&&action!=null){gap(detail,9);detail.addView(button("↗",actionLabel,false,action));}
        content.addView(detail);
        Button toggle=button("＋","상세 보기",false,()->{});
        content.addView(toggle,new LinearLayout.LayoutParams(-1,-2));
        toggle.setOnClickListener(v->{boolean expanded=detail.getVisibility()!=View.VISIBLE;detail.setVisibility(expanded?View.VISIBLE:View.GONE);toggle.setText(expanded?"－  접기":"＋  상세 보기");});
        card(body,content);
    }
    private void openInfoUrl(String url){try{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)));}catch(Exception e){Toast.makeText(this,"안내 페이지를 열지 못했습니다.",Toast.LENGTH_SHORT).show();}}
    private void showInfo(){
        title("층간소음 안내","필요한 내용을 먼저 요약으로 확인하고, 상세 보기에서 절차와 준비물을 살펴보세요.");
        LinearLayout summary=column();
        summary.addView(text("먼저 확인할 핵심",18,INK,true));gap(summary,9);
        TextView keyPoints=text("• 발생 날짜·시간·소리 유형을 꾸준히 기록하세요.\n• 층간소음 기준은 공동주택의 특정 충격음·공기전달음에 적용됩니다.\n• 상담은 전화 → 방문상담 → 필요 시 소음측정 순서로 진행됩니다.\n• 휴대폰 녹음·측정값은 공식 dB(A) 측정 결과가 아닙니다.\n• 이웃사이센터 1661-2642 (평일 09:00~18:00, 12:00~13:00 제외)",14,INK,false);
        keyPoints.setLineSpacing(dp(4),1f);summary.addView(keyPoints);gap(summary,8);
        summary.addView(text("아래 항목의 ‘상세 보기’를 누르면 적용 범위, 단계별 절차와 준비 서류를 확인할 수 있습니다.",12,MUTED,false));
        card(body,summary);

        infoSection("층간소음에 포함되는 소리",
                "걷거나 뛰는 충격음, TV·음향기기처럼 공기를 통해 전달되는 소음이 기본 범위입니다.",
                "「공동주택 층간소음의 범위와 기준에 관한 규칙」은 입주자 또는 사용자의 활동으로 발생해 다른 세대에 피해를 주는 소리를 규정합니다.\n\n• 직접충격 소음: 뛰거나 걷는 동작 등으로 생기는 소리\n• 공기전달 소음: 텔레비전·음향기기 사용 등으로 전달되는 소리\n• 명시된 제외: 욕실·화장실·다용도실 등에서 급수·배수로 생기는 소리\n\n공사, 동물 소리, 사람의 대화, 설비 소음 등은 상황과 원인에 따라 다른 기준이나 처리 경로가 적용될 수 있습니다. 모두를 일괄적으로 층간소음이라고 단정하기보다 관리주체나 이웃사이센터에 적용 범위를 확인하세요. 발생원이 확인되지 않으면 상대 세대와의 중재가 어려울 수 있습니다.",
                "공식 범위·절차 확인",()->openInfoUrl("https://floor.noiseinfo.or.kr/floornoise/home/notice/faq.do?boardNo=143"));

        infoSection("공동주택 소음 기준",
                "직접충격음은 1분, 공기전달음은 5분 단위로 평가합니다. 주간·야간 기준이 다릅니다.",
                "공동주택 세대 간 기준은 dB(A)이며, 주간은 06:00~22:00, 야간은 22:00~06:00입니다.\n\n• 직접충격음 1분 등가소음도(Leq): 주간 39 / 야간 34 dB(A)\n• 직접충격음 최고소음도(Lmax): 주간 57 / 야간 52 dB(A)\n• 공기전달음 5분 등가소음도(Leq): 주간 45 / 야간 40 dB(A)\n\n법령은 기준 이하가 되도록 노력할 의무를 정합니다. 측정 기준을 넘었다는 사실만으로 처벌이 자동 확정되는 것은 아닙니다. 적격한 일부 오래된 공동주택은 직접충격음 기준에 2 dB(A)를 더하는 특례가 있어 건축 시기와 승인 형태를 확인해야 합니다. 최고소음도는 1시간 동안 3회 이상 기준을 넘는지 평가합니다.\n\n이 앱의 휴대폰 녹음·신호값은 보정된 소음계로 잰 dB(A)가 아니며, 법정 측정이나 전문기관 결과를 대신하지 않습니다.",
                "현행 법령 확인",()->openInfoUrl("https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=247421"));

        infoSection("상담부터 측정까지",
                "전화상담에서 시작해 방문상담을 받고, 갈등이 계속되면 측정을 신청할 수 있습니다.",
                "1. 전화상담: 이웃사이센터 1661-2642로 대상 여부와 절차를 문의합니다. 평일 09:00~18:00 운영하며 12:00~13:00은 점심시간입니다.\n2. 방문상담 신청: 센터 누리집의 상담신청 등록 또는 전화로 신청합니다. 신청 후 접수 여부와 안내를 확인하세요.\n3. 방문상담: 관리주체가 있는지에 따라 센터 안내와 우선 중재 절차가 달라집니다. 당사자의 상담 참여가 필요한 경우가 있습니다.\n4. 소음측정: 방문상담 뒤에도 갈등이 계속될 때 수음세대(소음 피해를 받는 세대)가 신청할 수 있습니다. 센터 안내 기준으로 방문상담일부터 30일 이내 신청해야 하며, 접수 후 일정을 협의합니다.\n5. 측정 진행: 공식 소음측정은 보통 1~24시간 동안 진행됩니다. 정확한 측정을 위해 측정 세대 안의 소음원과 재실자를 비워야 할 수 있으므로 센터와 사전에 일정을 조율하세요.\n\n전화상담과 방문상담·측정은 갈등 완화를 위한 서비스입니다. 신청 가능 여부, 준비 서류, 일정은 주택 유형과 개별 상황을 센터에 확인하세요.",
                "이웃사이센터 최신 절차",()->openInfoUrl("https://floor.noiseinfo.or.kr/floornoise/home/guide/process.do"));

        infoSection("우리 집의 관리주체 여부에 따른 차이",
                "관리주체가 있으면 관리주체의 우선 중재를 거치고, 없으면 센터의 상대 세대 상담 절차로 진행합니다.",
                "관리주체가 있는 경우\n관리사무소장 등 관리주체가 우선 상담을 진행합니다. 해결되지 않으면 관리주체가 상담 결과 등 필요한 서류를 갖춰 전문기관 방문상담을 신청합니다. 방문상담 후에도 갈등이 지속되면 수음세대가 소음측정을 신청합니다.\n\n관리주체가 없는 경우\n관리주체의 우선 중재 단계 없이 센터에서 상대 세대에 상담 참여를 요청하고, 동의 여부를 확인해 방문상담을 조율합니다. 상대 세대의 참여가 어려운 경우에도 센터가 신청세대에 가능한 다음 절차를 안내합니다. 측정은 방문상담 후 갈등이 계속될 때 수음세대가 신청합니다.\n\n서비스 대상은 공동주택이며, 비공동주택은 다가구주택·주거용 오피스텔 입주자에게 전국 단위 방문상담·측정 서비스를 제공합니다. 비공동주택은 공동주택 기준표가 그대로 적용되지 않을 수 있으므로 상담 시 주택 유형을 먼저 알려 주세요.",
                "비공동주택 대상·절차 확인",()->openInfoUrl("https://floor.noiseinfo.or.kr/floornoise/home/guide/detachedHouse.do"));

        infoSection("신청 전에 준비할 자료",
                "상담 단계와 측정 단계의 양식이 다릅니다. 발생일지와 서명을 먼저 확인하세요.",
                "관리주체가 있는 방문상담에는 방문상담 신청서, 관리주체의 중재상담 기록·보고서, 동의서와 관리주체 확인 서류 등이 필요할 수 있습니다. 소음측정까지 진행할 때는 측정 신청서와 층간소음 발생일지를 추가로 준비합니다.\n\n관리주체가 없는 경우의 소음측정 신청에는 측정 신청서와 발생일지가 기본입니다. 신청 주체, 서명·동의, 접수 방법은 신청 경로와 주택 유형에 따라 달라질 수 있습니다.\n\n기록에는 발생 날짜·시간, 지속 시간, 반복 여부, 소리 유형과 생활 피해를 사실대로 적으세요. 제출 전 누락 서명이나 첨부 서류가 없는지 확인하고, 신청에 쓰는 최신 양식은 이웃사이센터에서 확인하는 것이 안전합니다.",
                "제출양식 메뉴 열기",()->{page="제출양식";render();});

        infoSection("무료 소음측정기 대여",
                "한국환경공단의 무료 대여는 공동주택 관리주체 대상이며, 입주민 개인은 신청할 수 없습니다.",
                "공동주택 관리주체가 자체 중재상담 자료로 활용하도록 측정기를 대여하는 서비스입니다. 관리사무소장 명의 신청서와 사업자등록증, 재직증명서 등을 준비해 센터에 신청합니다. 대여 장비의 표시값은 중재상담 참고용이며 법적 효력이 있는 전문기관 측정 결과가 아닙니다.\n\n신청 가능 여부, 대기기간, 구비서류 및 반납 조건은 바뀔 수 있으니 신청 전 공식 안내를 확인하세요.",
                "공단 무료대여 안내 보기",()->openInfoUrl("https://floor.noiseinfo.or.kr/floornoise/home/library/view.do?boardNo=96"));

        LinearLayout contact=column();contact.addView(text("공식 문의",18,INK,true));gap(contact,7);
        contact.addView(text("운영시간과 접수 조건은 변경될 수 있습니다. 신청 전 공식 안내에서 최신 내용을 확인하세요.",13,MUTED,false));gap(contact,8);
        contact.addView(button("☎","1661-2642 전화하기",false,()->{try{startActivity(new Intent(Intent.ACTION_DIAL,Uri.parse("tel:16612642")));}catch(Exception ignored){}}));gap(contact,5);
        contact.addView(button("↗","이웃사이센터 웹사이트 열기",false,()->openInfoUrl("https://floor.noiseinfo.or.kr/floornoise/home/main.do")));
        card(body,contact);

        gap(body,8);body.addView(text("동영상",18,INK,true));gap(body,5);body.addView(text("미리보기에서 영상을 열고, 시청 후 완료 여부를 표시하세요.",12,MUTED,false));gap(body,8);body.addView(text("심리편",16,INK,true));gap(body,5);video("셀프해우소 심리편","o71eR5qmi_Q","9:44");video("심리편 추가 영상","0OS2neAZXwE","");gap(body,8);body.addView(text("건축편",16,INK,true));gap(body,5);video("셀프해우소 건축편","NF7fmL68DCA","7:48");video("건축편 추가 영상","XqCvD3siGf0","");video("층간소음 예방 이웃사이2642 AI 공모전","6lzDyBN204A","2:54");
    }    private void openYoutube(String id){try{String url=id.equals("0OS2neAZXwE")?"https://youtu.be/0OS2neAZXwE?si=mJM6Rp-3v6MqL15v":"https://www.youtube.com/watch?v="+id;startActivity(new Intent(Intent.ACTION_VIEW,android.net.Uri.parse(url)));}catch(Exception e){Toast.makeText(this,"YouTube 영상을 열 수 없습니다.",Toast.LENGTH_SHORT).show();}}
    private void loadThumbnail(String id,ImageView target){new Thread(()->{HttpURLConnection conn=null;try{conn=(HttpURLConnection)new URL("https://i.ytimg.com/vi/"+id+"/hqdefault.jpg").openConnection();conn.setConnectTimeout(7000);conn.setReadTimeout(7000);conn.setInstanceFollowRedirects(true);Bitmap bitmap=BitmapFactory.decodeStream(conn.getInputStream());if(bitmap!=null)runOnUiThread(()->target.setImageBitmap(bitmap));}catch(Exception ignored){}finally{if(conn!=null)conn.disconnect();}}).start();}
    private void video(String name,String id,String duration){LinearLayout c=column();FrameLayout preview=new FrameLayout(this);ImageView image=new ImageView(this);image.setScaleType(ImageView.ScaleType.CENTER_CROP);image.setBackgroundColor(Color.rgb(32,42,54));image.setContentDescription(name+" YouTube 미리보기");preview.addView(image,new FrameLayout.LayoutParams(-1,-1));TextView play=text("▶",24,Color.WHITE,true);play.setGravity(Gravity.CENTER);GradientDrawable disc=new GradientDrawable();disc.setShape(GradientDrawable.OVAL);disc.setColor(Color.argb(210,31,42,55));play.setBackground(disc);FrameLayout.LayoutParams playLp=new FrameLayout.LayoutParams(dp(54),dp(54),Gravity.CENTER);preview.addView(play,playLp);preview.setOnClickListener(v->openYoutube(id));c.addView(preview,new LinearLayout.LayoutParams(-1,dp(190)));loadThumbnail(id,image);gap(c,9);LinearLayout titleRow=row();titleRow.addView(text(name,15,INK,true),new LinearLayout.LayoutParams(0,-2,1));titleRow.addView(text(duration,12,MUTED,false));c.addView(titleRow);gap(c,5);c.addView(button("▶","YouTube에서 재생",false,()->openYoutube(id)));CheckBox watched=new CheckBox(this);watched.setText("시청 완료");watched.setTextSize(13);watched.setChecked(getPreferences(0).getBoolean("watched_"+id,false));c.addView(watched);TextView state=text(watched.isChecked()?"시청 완료로 저장됨":"아직 시청 완료로 표시되지 않았습니다",11,watched.isChecked()?GREEN:MUTED,false);c.addView(state);watched.setOnCheckedChangeListener((b,checked)->{getPreferences(0).edit().putBoolean("watched_"+id,checked).apply();state.setText(checked?"시청 완료로 저장됨":"아직 시청 완료로 표시되지 않았습니다");state.setTextColor(checked?GREEN:MUTED);});card(body,c);}
    private CharSequence requiredLabel(String label,boolean required){if(!required)return label;android.text.SpannableString value=new android.text.SpannableString(label+" *");value.setSpan(new android.text.style.ForegroundColorSpan(Color.RED),label.length(),value.length(),android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);return value;}
    private EditText field(LinearLayout f,String label,String key,int type){return field(f,label,key,type,false);}
    private EditText field(LinearLayout f,String label,String key,int type,boolean required){gap(f,9);TextView caption=text(label,13,INK,true);caption.setTag("profile_label_"+key);caption.setText(requiredLabel(label,required));f.addView(caption);EditText e=input(label,type);e.setTag(key);e.setText(getPreferences(0).getString(key,""));f.addView(e);return e;}
    private interface ApartmentSelection { void select(String code, String name); }

    private void showApartmentSearch(String currentName, ApartmentSelection selection) {
        LinearLayout content = column();
        LinearLayout searchRow = row();
        EditText query = input("단지명 입력", InputType.TYPE_CLASS_TEXT);
        query.setSingleLine(true);
        query.setText(currentName);
        searchRow.addView(query, new LinearLayout.LayoutParams(0, -2, 1));
        content.addView(searchRow);
        TextView status = text("", 13, MUTED, false);
        content.addView(status);
        ScrollView scroll = new ScrollView(this);
        LinearLayout results = column();
        scroll.addView(results);
        scroll.setVisibility(View.GONE);
        content.addView(scroll, new LinearLayout.LayoutParams(-1, dp(220)));
        Dialog dialog = showCustomDialog("공동주택 검색", content, "닫기", null, false, null, null);
        Button search = button("검색", true, () -> {});
        searchRow.addView(search, new LinearLayout.LayoutParams(-2, -2));
        search.setOnClickListener(view -> {
            String name = query.getText().toString().trim();
            if (name.length() < 2) {
                query.setError("단지명을 두 글자 이상 입력해 주세요.");
                return;
            }
            android.view.inputmethod.InputMethodManager keyboard = (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (keyboard != null) keyboard.hideSoftInputFromWindow(query.getWindowToken(), 0);
            search.setEnabled(false);
            results.removeAllViews();
            scroll.setVisibility(View.GONE);
            status.setText("검색 중…");
            apiRequest("GET", "/apartments?name=" + android.net.Uri.encode(name), null, true, (data, error) -> {
                if (!dialog.isShowing()) return;
                search.setEnabled(true);
                if (error != null) { status.setText(error); return; }
                JSONArray options = data.optJSONArray("apartments");
                if (options == null || options.length() == 0) {
                    status.setText("검색 결과가 없습니다. 단지명 일부로 다시 검색해 주세요.");
                    return;
                }
                status.setText(options.length() == 30 ? "최대 30건을 표시합니다. 단지명과 주소를 확인해 주세요." : "단지명과 주소를 확인해 선택해 주세요.");
                scroll.setVisibility(View.VISIBLE);
                for (int i = 0; i < options.length(); i++) {
                    JSONObject item = options.optJSONObject(i);
                    if (item == null) continue;
                    String code = item.optString("kaptCode");
                    String title = item.optString("kaptName");
                    String address = item.optString("address");
                    Button choice = button(title + "\n" + address, false, () -> {
                        selection.select(code, title);
                        dialog.dismiss();
                    });
                    choice.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
                    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
                    params.topMargin = dp(6);
                    results.addView(choice, params);
                }
            });
        });
    }
    private static String formatPhoneDigits(String value) {
        String digits = normalizePhoneNumber(value);
        if (!digits.matches("[0-9]*")) return value;
        int length = digits.length();
        int prefixLength;
        if (length == 11) prefixLength = 3;
        else if ((length == 9 || length == 10) && digits.startsWith("02")) prefixLength = 2;
        else if (length == 10) prefixLength = 3;
        else if (length == 12 && digits.startsWith("050")) prefixLength = 4;
        else return digits;
        return digits.substring(0, prefixLength) + "-" + digits.substring(prefixLength, length - 4)
            + "-" + digits.substring(length - 4);
    }
    private void showAddressSearch(final EditText address,final EditText postal){
        final android.app.Dialog dialog=new android.app.Dialog(this);
        LinearLayout content=column();
        content.setBackgroundColor(Color.WHITE);
        LinearLayout header=row();
        header.setBackgroundColor(PAPER);
        pad(header,18,8,12,8);
        TextView heading=text("주소 검색",18,INK,true);
        heading.setGravity(Gravity.START|Gravity.CENTER_VERTICAL);
        header.addView(heading,new LinearLayout.LayoutParams(0,dp(48),1));
        header.addView(button("닫기",false,dialog::dismiss),new LinearLayout.LayoutParams(dp(72),dp(48)));
        content.addView(header,new LinearLayout.LayoutParams(-1,-2));
        View divider=new View(this);
        divider.setBackgroundColor(BORDER);
        content.addView(divider,new LinearLayout.LayoutParams(-1,dp(1)));
        final android.webkit.WebView web=new android.webkit.WebView(this);
        web.setBackgroundColor(Color.WHITE);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.setWebViewClient(new android.webkit.WebViewClient(){
            @Override public void onReceivedError(android.webkit.WebView view,android.webkit.WebResourceRequest request,android.webkit.WebResourceError error){
                super.onReceivedError(view,request,error);
                if(request.isForMainFrame())Toast.makeText(MainActivity.this,"주소 검색 페이지를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.",Toast.LENGTH_LONG).show();
            }
        });
        web.setWebChromeClient(new android.webkit.WebChromeClient(){
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message){android.util.Log.w("AddressSearchWeb",message.message()+" ("+message.sourceId()+":"+message.lineNumber()+")");return true;}
        });
        web.addJavascriptInterface(new Object(){
            @android.webkit.JavascriptInterface public void onAddressSelected(String roadAddress,String jibunAddress,String zonecode){runOnUiThread(()->{String selected=roadAddress==null||roadAddress.trim().isEmpty()?jibunAddress:roadAddress;address.setText(selected==null?"":selected);postal.setText(zonecode==null?"":zonecode);dialog.dismiss();});}
        },"AndroidAddress");
        dialog.setOnDismissListener(v->web.destroy());
        content.addView(web,new LinearLayout.LayoutParams(-1,0,1));
        dialog.setContentView(content);
        dialog.show();
        dialog.getWindow().setLayout(Math.min(getResources().getDisplayMetrics().widthPixels-dp(32),dp(520)),Math.min(getResources().getDisplayMetrics().heightPixels-dp(80),dp(620)));
        String html="<!doctype html><html style='height:100%'><head><meta name='viewport' content='width=device-width, initial-scale=1, maximum-scale=1'></head><body style='margin:0;height:100%'><div id='postcode' style='width:100%;height:100%;min-height:460px'></div><script src='https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js'></script><script>new daum.Postcode({oncomplete:function(data){AndroidAddress.onAddressSelected(data.roadAddress||'',data.jibunAddress||'',data.zonecode||'');},width:'100%',height:'100%'}).embed(document.getElementById('postcode'));</script></body></html>";
        web.loadDataWithBaseURL("https://postcode.map.daum.net/",html,"text/html","UTF-8",null);
    }
    private void applyPhoneFormatting(EditText field) {
        field.setInputType(InputType.TYPE_CLASS_PHONE);
        formatPhoneField(field);
        field.setOnFocusChangeListener((view, hasFocus) -> {
            if (!hasFocus) formatPhoneField(field);
        });
    }

    private void formatPhoneField(EditText field) {
        String current = field.getText().toString();
        String formatted = formatPhoneDigits(current);
        if (!current.equals(formatted)) field.setText(formatted);
    }
    private static String normalizePhoneNumber(String value) {
        String number = value.replaceAll("[\\s()-]", "");
        return number.startsWith("+82") ? "0" + number.substring(3) : number;
    }

    private static boolean validManagerPhone(String value) {
        return normalizePhoneNumber(value).matches("010[0-9]{8}|02[0-9]{7,8}|0[3-9][0-9]{8,9}|050[0-9]{9}");
    }
    private boolean validEmail(String value){return android.util.Patterns.EMAIL_ADDRESS.matcher(value.trim()).matches();}
    File getSignatureImageFile(){return new File(getFilesDir(),"signature.png");}
    private void showPolicy(String title,String content){TextView detail=text(content,14,INK,false);detail.setGravity(Gravity.START);ScrollView scroll=new ScrollView(this);scroll.addView(detail);scroll.setPadding(dp(20),dp(12),dp(20),dp(12));new AlertDialog.Builder(this).setTitle(title).setView(scroll).setPositiveButton("닫기",null).show();}
    private LinearLayout consentRow(CheckBox check,String title,String content){LinearLayout line=row();line.addView(check,new LinearLayout.LayoutParams(0,-2,1));TextView detail=text("[상세보기]",14,BLUE,true);detail.setGravity(Gravity.CENTER_VERTICAL);detail.setPadding(dp(10),dp(10),dp(4),dp(10));detail.setContentDescription(title+" 상세보기");detail.setOnClickListener(v->showPolicy(title,content));line.addView(detail,new LinearLayout.LayoutParams(-2,-2));return line;}
    private void showSignatureEditor(){LinearLayout box=column();box.addView(text("손가락으로 서명을 그려 주세요. PNG로 저장되어 나중에 문서 서명란에 사용됩니다.",13,MUTED,false));gap(box,8);SignatureCanvas drawing=new SignatureCanvas(this);GradientDrawable border=new GradientDrawable();border.setColor(Color.WHITE);border.setCornerRadius(dp(6));border.setStroke(dp(1),BORDER);drawing.setBackground(border);box.addView(drawing,new LinearLayout.LayoutParams(-1,dp(190)));gap(box,4);TextView clear=text("서명 다시 그리기",13,BLUE,true);clear.setGravity(Gravity.END|Gravity.CENTER_VERTICAL);clear.setPadding(dp(8),dp(10),dp(4),dp(8));clear.setClickable(true);clear.setOnClickListener(v->drawing.clear());box.addView(clear);showCustomDialog("서명 이미지 만들기",box,"저장","취소",false,()->{if(!drawing.hasInk()){showMessageDialog("서명 없음","저장하기 전에 서명을 그려 주세요.",false);return false;}try{Bitmap image=drawing.toBitmap();File target=getSignatureImageFile();try(FileOutputStream out=new FileOutputStream(target)){image.compress(Bitmap.CompressFormat.PNG,100,out);}image.recycle();if(signaturePreview!=null){signaturePreview.setImageBitmap(BitmapFactory.decodeFile(target.getAbsolutePath()));signaturePreview.setVisibility(View.VISIBLE);}handler.post(()->showMessageDialog("저장 완료","서명 이미지를 이 기기에 저장했습니다. 문서 양식에서 서명 이미지로 불러올 수 있습니다.",true));return true;}catch(Exception e){showMessageDialog("저장하지 못했습니다","서명 이미지를 저장하지 못했습니다. 저장 공간을 확인해 주세요.",false);return false;}},null);}
    private void deleteSignature(){LinearLayout content=column();content.addView(text("저장된 서명 이미지를 삭제합니다. 삭제 후에는 문서 양식에서 서명 이미지를 불러올 수 없습니다.",14,MUTED,false));showCustomDialog("서명 이미지 삭제",content,"삭제","취소",true,()->{getSignatureImageFile().delete();if(signaturePreview!=null){signaturePreview.setImageDrawable(null);signaturePreview.setVisibility(View.GONE);}handler.post(()->showMessageDialog("삭제 완료","저장된 서명 이미지를 삭제했습니다.",true));return true;},null);}
    private void confirmRemoveManagerDocument(){LinearLayout content=column();content.addView(text("첨부된 사업자등록증 사본의 앱 내 연결을 제거합니다. 원본 파일은 문서 앱이나 파일 제공자에 남을 수 있습니다.",14,MUTED,false));showCustomDialog("첨부 파일 제거",content,"제거","취소",true,()->{String saved=getPreferences(0).getString("profile_manager_business_doc_uri","");if(!saved.isEmpty()){try{getContentResolver().releasePersistableUriPermission(android.net.Uri.parse(saved),Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){}getPreferences(0).edit().remove("profile_manager_business_doc_uri").apply();}if(managerDocLabel!=null)managerDocLabel.setText("첨부 파일 없음");handler.post(()->showMessageDialog("제거 완료","사업자등록증 사본의 앱 내 첨부를 제거했습니다.",true));return true;},null);}    private void showProfile(){
        if(getPreferences(0).getString("auth_token","").isEmpty()){page="계정";render();return;}
        title("내 정보","회원 계정에 입주민과 관리주체 정보를 저장합니다.");
        final String termsText="MuteLab 이용약관 및 서비스 안내\n\n1. 앱은 소음 녹음, 상황 기록, 녹음 분석 결과 확인 기능을 제공합니다.\n\n2. 휴대폰 녹음 레벨은 마이크 특성이 보정되지 않은 디지털 상대값(dBFS)입니다. 공식 dB(A) 소음측정 결과나 법률·위원회 판단을 대신하지 않습니다.\n\n3. 이용자는 녹음·일지·관리주체 정보·서명 이미지·첨부 서류를 정확하게 입력하고 본인이 관리해야 합니다. 다른 사람의 개인정보나 권리를 침해하는 내용은 기록·공유하지 않도록 유의해 주세요.\n\n4. 계정과 프로필, 동기화한 녹음 원본은 MuteLab 서버에 저장합니다. 이용자가 층간소음 발생일지 제출을 선택하면 제출 음원과 분석·일지 정보가 해당 단지 위원회에 제공됩니다. 가입과 계정 복구에 사용하는 인증코드는 이메일로 발송합니다.\n\n5. 앱에서 생성한 서명 이미지는 문서 양식의 서명란에 삽입할 용도로 이 기기에 저장됩니다.";
        final String privacyText="개인정보 이용 안내\n\n저장 항목과 목적\n• 입주자 이름, 이메일, 연락처, 주소 및 관리주체 정보: 앱 프로필과 신청세대 확인에 사용하며 MuteLab 서버에 저장하고 로그인한 기기와 API 사이에서 전송합니다.\n• 녹음 파일과 소음 발생 일지: 기기에서 기록을 확인할 수 있도록 저장하며, 동기화 시 원본 녹음과 일지가 서버에 저장됩니다. 이용자가 층간소음 발생일지를 제출하면 별도의 제출 음원 사본이 서버에 저장되어 해당 단지 위원회가 재생하고 원본 해시와 비교할 수 있습니다.\n• 녹음 분석 정보: 최소·최대 녹음 레벨, 시작·종료 시각, 발생 추정 장소, 피해 상황, 상대세대 정보와 (해당되는 경우) 위치 위도·경도 및 공개 IP 주소가 발생일지 제출 시 해당 단지 위원회에 제공됩니다. 위치와 IP는 권한·네트워크·VPN 등에 따라 미상이거나 달라질 수 있습니다.\n• 서명 이미지(PNG): 문서 양식의 서명란에 사용하기 위해 앱 전용 저장공간에 둡니다.\n• 관리주체 사업자등록증 사본: 입주민 프로필에서 선택한 파일의 접근 권한과 이름만 이 기기에서 관리하며 이 경로에서는 서버로 업로드하지 않습니다.\n\n보관과 철회\n앱 삭제 시 기기의 앱 전용 데이터는 제거될 수 있지만 서버에 동기화하거나 위원회에 제출한 데이터는 자동으로 삭제되지 않습니다. 위원회 제출을 철회하면 위원회 일반 조회에서는 숨겨지며, 원본·제출 음원과 무결성 감사 기록은 위변조 방지와 분쟁 이력 보전을 위해 서버에 남을 수 있습니다. 파일 제공자에 남은 원본 파일은 앱의 첨부 연결을 제거해도 별도로 남을 수 있습니다.";

// 주소검색 버튼 → 카카오 우편번호 검색 위젯에서 기본주소와 우편번호를 받아 채움
        LinearLayout f=column();
        EditText accountId=field(f,"회원 아이디","profile_login",InputType.TYPE_CLASS_TEXT);accountId.setText(getPreferences(0).getString("auth_login_id",""));accountId.setEnabled(false);
        field(f,"이름","profile_name",InputType.TYPE_CLASS_TEXT,true);EditText profileEmail=field(f,"이메일","profile_email",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS,true);String accountEmail=getPreferences(0).getString("auth_email","");if(!accountEmail.isEmpty()){profileEmail.setText(accountEmail);profileEmail.setEnabled(false);}applyPhoneFormatting(field(f,"연락처","profile_phone",InputType.TYPE_CLASS_PHONE,true));
        gap(f,9);TextView cap1=text("주소1",13,INK,true);cap1.setTag("profile_label_profile_address");f.addView(cap1);
        EditText address1=input("주소1",InputType.TYPE_CLASS_TEXT);address1.setTag("profile_address");address1.setEnabled(false);address1.setHint("주소검색으로 입력");address1.setText(getPreferences(0).getString("profile_address",""));
        EditText postal= new EditText(this);postal.setTag("profile_postal");postal.setVisibility(View.GONE);postal.setText(getPreferences(0).getString("profile_postal",""));
        LinearLayout addressRow=row();addressRow.addView(address1,new LinearLayout.LayoutParams(0,-2,1));addressRow.addView(button("주소검색",false,()->showAddressSearch(address1,postal)),new LinearLayout.LayoutParams(-2,-2));f.addView(addressRow);gap(f,8);
        // 주소2: 동·호수 상세주소는 직접 입력 + 정확 기재 안내 문구
        EditText address2=field(f,"주소2 (동·호수)","profile_address2",InputType.TYPE_CLASS_TEXT,false);f.addView(text("※ 카카오맵에서 선택한 주소의 동·호수를 정확히 기재해 주세요. (예: 101동 1203호)",12,MUTED,false));
        gap(f,2);TextView postalCaption=text("우편번호",12,MUTED,false);postalCaption.setTag("profile_label_profile_postal");f.addView(postalCaption);postal.setVisibility(View.VISIBLE);postal.setEnabled(false);postal.setHint("주소 검색 시 자동 입력");postal.setTextSize(14);postal.setPadding(dp(12),dp(8),dp(12),dp(8));f.addView(postal);
        gap(f,14);f.addView(text("서명 이미지",17,INK,true));gap(f,4);f.addView(text("나중에 문서 양식의 서명란에 사용할 서명을 만들어 저장합니다.",12,MUTED,false));signaturePreview=new ImageView(this);signaturePreview.setAdjustViewBounds(true);signaturePreview.setScaleType(ImageView.ScaleType.FIT_CENTER);File signature=getSignatureImageFile();if(signature.exists()){Bitmap image=BitmapFactory.decodeFile(signature.getAbsolutePath());if(image!=null){signaturePreview.setImageBitmap(image);signaturePreview.setVisibility(View.VISIBLE);}else signaturePreview.setVisibility(View.GONE);}else signaturePreview.setVisibility(View.GONE);f.addView(signaturePreview,new LinearLayout.LayoutParams(-1,dp(90)));gap(f,4);f.addView(button("✎","서명 이미지 만들기 / 수정",false,this::showSignatureEditor));gap(f,4);f.addView(button("✕","저장된 서명 삭제",false,this::deleteSignature));
        gap(f,14);
        CheckBox has = new CheckBox(this);
        has.setText("층간소음 관리주체가 있습니다");
        has.setTextSize(14);
        has.setChecked(getBooleanPreference("profile_manager", false));
        f.addView(has);
        gap(f,6);
        f.addView(text("관리주체 정보",17,INK,true));
        EditText house = field(f,"(공동)주택명","profile_house",InputType.TYPE_CLASS_TEXT);
        house.setKeyListener(null);
        house.setFocusable(false);
        house.setCursorVisible(false);
        String[] selectedKaptCode = { getPreferences(0).getString("profile_kapt_code","") };
        Button findHouse = button("공동주택 검색", false, () -> showApartmentSearch(house.getText().toString(), (code, name) -> {
            selectedKaptCode[0] = code;
            house.setText(name);
        }));
        gap(f,6);
        f.addView(findHouse);
        EditText managerName = field(f,"관리주체명","profile_manager_name",InputType.TYPE_CLASS_TEXT);
        EditText managerRepresentative = field(f,"대표자성명","profile_manager_representative",InputType.TYPE_CLASS_TEXT);
        EditText managerPhone = field(f,"연락처","profile_manager_phone",InputType.TYPE_CLASS_PHONE);
        applyPhoneFormatting(managerPhone);
        EditText managerEmail = field(f,"전자우편","profile_manager_email",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        View[] managerFields = { house, findHouse, managerName, managerRepresentative, managerPhone, managerEmail };
        for (View field : managerFields) field.setEnabled(has.isChecked());
        has.setOnCheckedChangeListener((button,checked) -> {
            for (View field : managerFields) field.setEnabled(checked);
        });
        gap(f,10);f.addView(text("사업자등록증 사본 · 선택",13,INK,true));managerDocLabel=text("첨부 파일 없음",12,MUTED,false);String docUri=getPreferences(0).getString("profile_manager_business_doc_uri","");if(!docUri.isEmpty())managerDocLabel.setText("첨부 파일: "+documentDisplayName(android.net.Uri.parse(docUri)));f.addView(managerDocLabel);gap(f,5);f.addView(button("사업자등록증 사본 선택",false,this::pickManagerDocument));gap(f,4);f.addView(button("첨부 파일 제거",false,this::confirmRemoveManagerDocument));
        gap(f,8);CheckBox terms=new CheckBox(this);terms.setText(requiredLabel("이용약관에 동의합니다",true));terms.setTextSize(13);terms.setChecked(getBooleanPreference("profile_terms",false));f.addView(consentRow(terms,"이용약관",termsText));CheckBox privacy=new CheckBox(this);privacy.setText(requiredLabel("개인정보 이용에 동의합니다",true));privacy.setTextSize(13);privacy.setChecked(getBooleanPreference("profile_privacy",false));f.addView(consentRow(privacy,"개인정보 이용 안내",privacyText));CheckBox push=new CheckBox(this);push.setText("푸시 알림 수신 동의 (선택)");push.setTextSize(13);f.addView(push);CheckBox email=new CheckBox(this);email.setText("이메일 안내 수신 동의 (선택)");email.setTextSize(13);f.addView(email);
        card(body,f);body.addView(button("✓","정보 저장",true,()->{if(!terms.isChecked()||!privacy.isChecked()){Toast.makeText(this,"이용약관과 개인정보 이용 안내를 확인하고 동의해 주세요.",Toast.LENGTH_LONG).show();return;}String residentName=getFieldValue(f,"profile_name").trim(),residentEmail=getFieldValue(f,"profile_email").trim(),residentPhone=getFieldValue(f,"profile_phone").trim();
        String addr1=address1.getText().toString().trim(),addr2=getFieldValue(f,"profile_address2").trim();String residentAddress=addr1.isEmpty()?(addr2.isEmpty()?"":addr2):(addr2.isEmpty()?addr1:addr1+" "+addr2);
        if(residentName.isEmpty()||residentEmail.isEmpty()||residentPhone.isEmpty()){Toast.makeText(this,"별표(*)가 표시된 필수 항목을 입력해 주세요.",Toast.LENGTH_LONG).show();return;}
        if(residentAddress.isEmpty()){Toast.makeText(this,"주소검색으로 주소를 지정하거나 상세주소(주소2)를 입력해 주세요.",Toast.LENGTH_LONG).show();return;}if(!validEmail(residentEmail)){EditText e=findField(f,"profile_email");if(e!=null){e.setError("이메일 주소 형식을 확인해 주세요.");e.requestFocus();}return;}if(!validManagerPhone(residentPhone)){EditText e=findField(f,"profile_phone");if(e!=null){e.setError("전화번호 형식을 확인해 주세요. 예: 010-1234-5678");e.requestFocus();}return;}String phone=managerPhone.getText().toString().trim(),mail=managerEmail.getText().toString().trim();if(has.isChecked()&&selectedKaptCode[0].isEmpty()){showMessageDialog("공동주택 선택","검색 결과에서 단지명과 주소를 확인해 공동주택을 선택해 주세요.",false);return;}if(has.isChecked()&&!phone.isEmpty()&&!validManagerPhone(phone)){managerPhone.setError("전화번호 형식을 확인해 주세요. 예: 02-1234-5678");managerPhone.requestFocus();return;}if(has.isChecked()&&!mail.isEmpty()&&!validEmail(mail)){managerEmail.setError("전자우편 주소 형식을 확인해 주세요.");managerEmail.requestFocus();return;}android.content.SharedPreferences.Editor ed=getPreferences(0).edit().putBoolean("profile_manager",has.isChecked()).putBoolean("profile_terms",true).putBoolean("profile_privacy",true).putBoolean("profile_saved",true).putString("profile_address",addr1).putString("profile_postal",postal.getText().toString().trim());for(int i=0;i<f.getChildCount();i++)if(f.getChildAt(i) instanceof EditText){EditText e=(EditText)f.getChildAt(i);if(e.getTag()!=null){String val=e.getText().toString().trim();if("profile_phone".equals(String.valueOf(e.getTag()))||"profile_manager_phone".equals(String.valueOf(e.getTag())))val=val.replaceAll("[^0-9]","");ed.putString(String.valueOf(e.getTag()),val);}}String kaptCode=has.isChecked()?selectedKaptCode[0]:"";ed.putString("profile_kapt_code",kaptCode);JSONObject profileData=new JSONObject();try{for(int i=0;i<f.getChildCount();i++)if(f.getChildAt(i) instanceof EditText){EditText e=(EditText)f.getChildAt(i);if(e.getTag()!=null)profileData.put(String.valueOf(e.getTag()),e.getText().toString().trim());}profileData.put("profile_address",addr1);profileData.put("profile_postal",postal.getText().toString().trim());profileData.put("profile_manager",has.isChecked());profileData.put("profile_kapt_code",kaptCode);}catch(Exception ignored){}apiRequest("PUT","/profile",json("profile",profileData),true,(saved,error)->{if(error!=null){showMessageDialog("저장 실패",error,false);return;}ed.apply();handler.postDelayed(this::syncReportedCommitteeSubmissions,300);showMessageDialog("저장 완료","내 정보와 동의 내역을 회원 계정에 저장했습니다.",true);});}));gap(body,8);body.addView(text("계정 인증과 비밀번호 재설정은 로컬 API에서 처리합니다. 실제 이메일 발송과 계정 탈퇴 기능은 아직 연결되지 않았습니다. 비밀번호 원문은 기기나 데이터베이스에 저장하지 않습니다.",12,MUTED,false));
    }    private EditText findField(LinearLayout form,String key){for(int i=0;i<form.getChildCount();i++)if(form.getChildAt(i) instanceof EditText){EditText e=(EditText)form.getChildAt(i);if(key.equals(e.getTag()))return e;}return null;}
    private String getFieldValue(LinearLayout form,String key){for(int i=0;i<form.getChildCount();i++)if(form.getChildAt(i) instanceof EditText){EditText e=(EditText)form.getChildAt(i);if(key.equals(e.getTag()))return e.getText().toString();}return "";}
}












