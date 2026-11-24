package io.diwith.mutelab;

import android.content.Context;
import android.net.Uri;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

final class FormDocuments {
    static final String AUTHORITY = "io.diwith.mutelab.formfiles";

    static final class Form {
        final String id;
        final String title;
        final String asset;
        final String filename;

        Form(String id, String title, String asset, String filename) {
            this.id = id;
            this.title = title;
            this.asset = asset;
            this.filename = filename;
        }
    }

    static final Form[] ALL = {
        new Form("visit_consultation", "층간소음 방문상담 신청서", "visit_consultation.pdf", "[별지 제1호 서식]관리주체가있는경우_층간소음방문상담신청서.pdf"),
        new Form("noise_measurement_request", "층간소음 측정 신청서", "noise_measurement_request.pdf", "[별지 제3호 서식]공통_층간소음측정신청서.pdf"),
        new Form("noise_incident_log", "층간소음 발생 일지", "noise_incident_log.pdf", "[붙임]공통_층간소음발생일지.pdf"),
        new Form("consent_form", "동의서", "consent_form.pdf", "[붙임]관리주체가있는경우_동의서.pdf"),
        new Form("mediation_report", "층간소음 중재상담 보고서", "mediation_report.pdf", "[붙임]관리주체가있는경우_층간소음중재상담보고서.pdf"),
        new Form("security_staff_log", "경비직원용 층간소음 민원 상담일지", "security_staff_log.pdf", "4. [경비직원용 층간소음 민원 상담일지]_관리주체가 있는 경우.pdf")
    };

    private FormDocuments() {}

    static Form find(String id) {
        if (id == null) return null;
        for (Form form : ALL) if (form.id.equals(id)) return form;
        return null;
    }

    static File materialize(Context context, Form form) throws Exception {
        File dir = new File(context.getCacheDir(), "forms");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("양식 캐시 폴더를 만들지 못했습니다.");
        File target = new File(dir, form.asset);
        if (!target.isFile() || target.length() == 0) {
            try (InputStream in = context.getAssets().open("forms/" + form.asset);
                 OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            }
        }
        return target;
    }

    static Uri contentUri(Form form) {
        return Uri.parse("content://" + AUTHORITY + "/form/" + form.id);
    }
}
