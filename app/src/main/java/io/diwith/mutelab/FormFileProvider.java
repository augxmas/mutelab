package io.diwith.mutelab;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

public final class FormFileProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }

    @Override public String getType(Uri uri) { return "application/pdf"; }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        FormDocuments.Form form = FormDocuments.find(uri.getLastPathSegment());
        if (form == null) return null;
        String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = form.filename;
            else if (OpenableColumns.SIZE.equals(columns[i])) {
                try { row[i] = FormDocuments.materialize(getContext(), form).length(); }
                catch (Exception ignored) { row[i] = 0L; }
            }
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("읽기 전용 양식입니다.");
        FormDocuments.Form form = FormDocuments.find(uri.getLastPathSegment());
        if (form == null) throw new FileNotFoundException("양식을 찾을 수 없습니다.");
        try { return ParcelFileDescriptor.open(FormDocuments.materialize(getContext(), form), ParcelFileDescriptor.MODE_READ_ONLY); }
        catch (Exception e) { throw new FileNotFoundException(e.getMessage()); }
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("읽기 전용"); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("읽기 전용"); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("읽기 전용"); }
}
