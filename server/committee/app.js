(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const tokenKey = 'mutelabCommitteeToken';
  let token = sessionStorage.getItem(tokenKey) || '';
  let loginChallenge = '';
  let selectedApartment = null;
  let signupEmail = '';
  let signupVerificationToken = '';
  let signupDocumentFile = null;
  let incidents = [];
  let currentMember = null;
  const selectedRecords = new Set();
  const audioUrls = new Map();

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
      if (response.status === 401 && path.startsWith('/api/committee/') && !path.includes('/login')) signOut();
      throw new Error(payload?.error || '요청을 처리하지 못했습니다.');
    }
    return payload;
  }

  async function requestBlob(path, body) {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401) signOut();
      let message = 'PDF를 만들지 못했습니다.';
      try { message = (await response.json()).error || message; } catch { /* use default */ }
      throw new Error(message);
    }
    return { blob: await response.blob(), disposition: response.headers.get('content-disposition') || '' };
  }

  function setMessage(element, message, success = false) {
    element.textContent = message;
    element.classList.toggle('success', success);
  }

  function setSignupStep(step) {
    [1, 2, 3].forEach(number => {
      $(`#signupStep${number}`).hidden = number !== step;
      document.querySelector(`[data-step="${number}"]`).classList.toggle('active', number === step);
    });
    document.querySelectorAll('[data-footer-step]').forEach(actions => {
      actions.hidden = Number(actions.dataset.footerStep) !== step;
    });
    $('.signup-dialog-body').scrollTop = 0;
  }

  const phoneDigits = value => String(value || '').replace(/\D/g, '');

  function formatKoreanPhone(value) {
    const digits = phoneDigits(value);
    if (digits.startsWith('02')) {
      if (digits.length === 9) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`;
      if (digits.length === 10) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
    }
    if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
    return digits;
  }

  ['#signupMobile', '#signupContact'].forEach(selector => {
    const input = $(selector);
    const isMobile = selector === '#signupMobile';
    const syncPhone = format => {
      const digits = phoneDigits(input.value);
      input.value = format ? formatKoreanPhone(digits) : digits;
      const valid = isMobile ? /^010\d{8}$/.test(digits) : /^\d{8,11}$/.test(digits);
      input.setCustomValidity(!digits || valid ? ''
        : isMobile ? '모바일폰은 010으로 시작하는 11자리 숫자로 입력해 주세요.'
          : '연락처는 지역번호를 포함한 8~11자리 숫자로 입력해 주세요.');
    };
    input.addEventListener('focus', () => syncPhone(false));
    input.addEventListener('input', () => syncPhone(false));
    input.addEventListener('blur', () => syncPhone(true));
  });

  function documentTypeAllowed(file) {
    const allowedTypes = new Set(['application/pdf', 'image/png', 'image/jpeg']);
    const allowedExtension = /\.(pdf|png|jpe?g)$/i.test(file.name);
    return allowedTypes.has(file.type) || (!file.type && allowedExtension);
  }

  function clearDocumentFile(message = '선택된 파일이 없습니다.', invalid = false) {
    signupDocumentFile = null;
    $('#businessDocumentInput').value = '';
    const dropZone = $('#businessDocumentDropZone');
    const status = $('#businessDocumentStatus');
    dropZone.classList.remove('has-file');
    dropZone.setAttribute('aria-invalid', String(invalid));
    status.classList.toggle('error', invalid);
    status.classList.remove('success');
    status.textContent = message;
  }

  function selectDocumentFile(file) {
    if (!(file instanceof File) || !file.size) {
      clearDocumentFile('사업자등록증 파일을 선택해 주세요.', true);
      return;
    }
    if (!documentTypeAllowed(file)) {
      clearDocumentFile('PDF, PNG, JPEG 파일만 첨부할 수 있습니다.', true);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      clearDocumentFile('첨부 파일은 10MB 이하여야 합니다.', true);
      return;
    }
    signupDocumentFile = file;
    const dropZone = $('#businessDocumentDropZone');
    const status = $('#businessDocumentStatus');
    dropZone.classList.add('has-file');
    dropZone.setAttribute('aria-invalid', 'false');
    status.classList.remove('error');
    status.classList.add('success');
    status.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)}MB · 업로드 준비 완료`;
  }

  const documentInput = $('#businessDocumentInput');
  const documentDropZone = $('#businessDocumentDropZone');
  documentInput.addEventListener('change', () => selectDocumentFile(documentInput.files?.[0]));
  documentDropZone.addEventListener('click', () => documentInput.click());
  documentDropZone.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    documentInput.click();
  });
  ['dragenter', 'dragover'].forEach(type => documentDropZone.addEventListener(type, event => {
    event.preventDefault();
    documentDropZone.classList.add('is-dragover');
  }));
  ['dragleave', 'drop'].forEach(type => documentDropZone.addEventListener(type, event => {
    event.preventDefault();
    documentDropZone.classList.remove('is-dragover');
  }));
  documentDropZone.addEventListener('drop', event => {
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    if (files.length > 1) {
      clearDocumentFile('사업자등록증 파일은 하나만 첨부해 주세요.', true);
      return;
    }
    selectDocumentFile(files[0]);
  });

  $('#openSignup').addEventListener('click', () => {
    selectedApartment = null;
    signupEmail = '';
    signupVerificationToken = '';
    $('#apartmentForm').reset();
    $('#apartmentResults').replaceChildren();
    $('#toEmailStep').disabled = true;
    $('#emailStartForm').reset();
    $('#emailVerifyForm').reset();
    $('#emailVerifyForm').hidden = true;
    $('#verifyEmailCode').hidden = true;
    $('#signupForm').reset();
    $('#signupMobile').setCustomValidity('');
    $('#signupContact').setCustomValidity('');
    $('#signupBaseAddress').value = '';
    clearDocumentFile();
    setMessage($('#signupEmailMessage'), '');
    setMessage($('#signupMessage'), '');
    setSignupStep(1);
    $('#signupDialog').showModal();
  });

  $('#apartmentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const query = $('#apartmentQuery').value.trim();
    const results = $('#apartmentResults');
    results.replaceChildren();
    selectedApartment = null;
    $('#toEmailStep').disabled = true;
    $('#signupBaseAddress').value = '';
    try {
      const data = await request(`/api/committee/apartments?name=${encodeURIComponent(query)}`);
      if (!data.apartments.length) {
        const empty = document.createElement('p');
        empty.className = 'muted'; empty.textContent = '검색된 등록 단지가 없습니다.'; results.append(empty);
        return;
      }
      data.apartments.forEach(apartment => {
        const option = document.createElement('button');
        option.type = 'button'; option.className = 'apartment-option'; option.setAttribute('role', 'option');
        const name = document.createElement('strong'); name.textContent = apartment.kaptName;
        const address = document.createElement('span'); address.textContent = apartment.address || '주소 정보 없음';
        option.append(name, address);
        option.addEventListener('click', () => {
          selectedApartment = apartment;
          results.querySelectorAll('.apartment-option').forEach(button => button.classList.remove('selected'));
          option.classList.add('selected'); option.setAttribute('aria-selected', 'true');
          $('#signupBaseAddress').value = apartment.address || '';
          $('#toEmailStep').disabled = false;
        });
        results.append(option);
      });
    } catch (error) {
      const row = document.createElement('p'); row.className = 'message'; row.textContent = error.message; results.append(row);
    }
  });

  $('#toEmailStep').addEventListener('click', () => {
    if (!selectedApartment) return;
    $('#selectedApartmentText').textContent = `${selectedApartment.kaptName} · ${selectedApartment.address || ''}`;
    $('#signupBaseAddress').value = selectedApartment.address || '';
    setSignupStep(2);
  });

  $('#emailStartForm').addEventListener('submit', async event => {
    event.preventDefault();
    signupEmail = $('#signupEmail').value.trim().toLowerCase();
    try {
      const data = await request('/api/auth/email/start', {
        method: 'POST', body: JSON.stringify({ email: signupEmail, purpose: 'committee-signup' }),
      });
      $('#emailVerifyForm').hidden = false;
      $('#verifyEmailCode').hidden = false;
      setMessage($('#signupEmailMessage'), data.message, true);
      $('#signupEmailCode').focus();
    } catch (error) { setMessage($('#signupEmailMessage'), error.message); }
  });

  $('#emailVerifyForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = await request('/api/auth/email/verify', {
        method: 'POST', body: JSON.stringify({ email: signupEmail, purpose: 'committee-signup', code: $('#signupEmailCode').value.trim() }),
      });
      signupVerificationToken = data.verificationToken;
      $('#verifiedSummary').textContent = `${selectedApartment.kaptName} · ${signupEmail} 인증 완료`;
      $('#signupBaseAddress').value = selectedApartment.address || '';
      setSignupStep(3);
    } catch (error) { setMessage($('#signupEmailMessage'), error.message); }
  });

  function fileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('첨부 파일을 읽지 못했습니다.'));
      reader.readAsDataURL(file);
    });
  }

  $('#signupForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = signupDocumentFile;
    if (!(file instanceof File) || !file.size) { setMessage($('#signupMessage'), '사업자등록증을 첨부해 주세요.'); return; }
    if (file.size > 10 * 1024 * 1024) { setMessage($('#signupMessage'), '첨부 파일은 10MB 이하여야 합니다.'); return; }
    if (form.get('password') !== form.get('passwordConfirm')) { setMessage($('#signupMessage'), '비밀번호 확인이 일치하지 않습니다.'); return; }
    const button = $('#submitSignup');
    button.disabled = true;
    try {
      const body = {
        kaptCode: selectedApartment.kaptCode, email: signupEmail, verificationToken: signupVerificationToken,
        loginId: form.get('loginId'), name: form.get('name'), mobile: phoneDigits(form.get('mobile')),
        contact: phoneDigits(form.get('contact')), addressDetail: String(form.get('addressDetail') || '').trim(), role: form.get('role'),
        password: form.get('password'), passwordConfirm: form.get('passwordConfirm'),
        documentName: file.name, document: await fileAsBase64(file),
        terms: form.get('terms') === 'on', privacy: form.get('privacy') === 'on', disclosure: form.get('disclosure') === 'on',
      };
      const data = await request('/api/committee/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/vnd.mutelab.committee+json' }, body: JSON.stringify(body),
      });
      $('#signupDialog').close();
      $('#loginId').value = String(form.get('loginId'));
      $('#loginPassword').value = '';
      setMessage($('#authMessage'), data.message, true);
    } catch (error) { setMessage($('#signupMessage'), error.message); }
    finally { button.disabled = false; }
  });

  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = await request('/api/committee/login', {
        method: 'POST', body: JSON.stringify({ loginId: $('#loginId').value.trim(), password: $('#loginPassword').value }),
      });
      loginChallenge = data.challengeId;
      $('#loginForm').hidden = true; $('#loginOtpForm').hidden = false;
      setMessage($('#authMessage'), data.message, true); $('#loginOtp').focus();
    } catch (error) { setMessage($('#authMessage'), error.message); }
  });

  $('#loginBack').addEventListener('click', () => {
    loginChallenge = ''; $('#loginOtpForm').reset(); $('#loginOtpForm').hidden = true; $('#loginForm').hidden = false;
    setMessage($('#authMessage'), '');
  });

  $('#loginOtpForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = await request('/api/committee/login/verify', {
        method: 'POST', body: JSON.stringify({ challengeId: loginChallenge, code: $('#loginOtp').value.trim() }),
      });
      token = data.token; sessionStorage.setItem(tokenKey, token); await openDashboard();
    } catch (error) { setMessage($('#authMessage'), error.message); }
  });

  function signOut() {
    token = ''; currentMember = null; sessionStorage.removeItem(tokenKey); selectedRecords.clear();
    audioUrls.forEach(url => URL.revokeObjectURL(url)); audioUrls.clear();
    $('#dashboard').hidden = true; $('#authView').hidden = false;
    $('#loginOtpForm').hidden = true; $('#loginForm').hidden = false; $('#loginPassword').value = '';
  }
  $('#logout').addEventListener('click', signOut);

  async function openDashboard() {
    $('#authView').hidden = true; $('#dashboard').hidden = false;
    try {
      const me = await request('/api/committee/me');
      currentMember = me.current || null;
      $('#complexName').textContent = `${me.complex?.kaptName || '등록 단지'} · ${me.complex?.address || ''}`;
      const representative = me.representative ? `위원장 ${me.representative.name}` : '위원장 미등록';
      $('#memberSummary').replaceChildren();
      const title = document.createElement('strong'); title.textContent = me.complex?.kaptName || '위원회';
      const line = document.createElement('span'); line.textContent = `${me.members.length}명 · ${representative}`;
      $('#memberSummary').append(title, line);
      await loadIncidents();
    } catch (error) {
      setMessage($('#dashboardMessage'), error.message);
      if (!token) signOut();
    }
  }

  function filtersQuery() {
    const form = new FormData($('#filters'));
    const params = new URLSearchParams();
    for (const [key, value] of form) if (String(value).trim()) params.set(key, String(value).trim());
    return params.toString();
  }

  async function loadIncidents() {
    setMessage($('#dashboardMessage'), '');
    const data = await request(`/api/committee/incidents?${filtersQuery()}`);
    incidents = data.incidents;
    selectedRecords.clear(); updateSelection(); renderRows();
  }

  $('#filters').addEventListener('submit', event => { event.preventDefault(); loadIncidents().catch(error => setMessage($('#dashboardMessage'), error.message)); });
  $('#resetFilters').addEventListener('click', () => { $('#filters').reset(); loadIncidents().catch(error => setMessage($('#dashboardMessage'), error.message)); });

  function appendTextCell(row, value) {
    const cell = document.createElement('td'); cell.textContent = value || '-'; row.append(cell); return cell;
  }
  const dateTime = value => new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
  const integrityInfo = status => ({
    VERIFIED: ['원본 일치', 'verified'],
    MISMATCH_BLOCKED: ['불일치 · 차단', 'blocked'],
    PENDING: ['검증 대기', 'pending'],
  }[status] || ['확인 필요', 'pending']);
  const canAdvance = incident => incident.integrityStatus === 'VERIFIED';

  function integrityBadge(status) {
    const [label, className] = integrityInfo(status);
    const badge = document.createElement('span'); badge.className = `integrity-badge ${className}`;
    badge.textContent = label; return badge;
  }

  function renderRows() {
    const body = $('#incidentRows'); body.replaceChildren();
    $('#resultCount').textContent = `총 ${incidents.length}건`;
    $('#emptyState').hidden = incidents.length !== 0; $('.table-scroll').hidden = incidents.length === 0;
    const selectable = incidents.filter(canAdvance);
    const userCount = new Set(selectable.map(incident => incident.userId)).size;
    $('#selectAll').disabled = userCount > 1 || selectable.length === 0;
    $('#selectAll').title = userCount > 1 ? '같은 신청세대의 발생일시만 선택할 수 있습니다.' : '';
    incidents.forEach(incident => {
      const row = document.createElement('tr'); row.dataset.recordNo = incident.recordNo;
      const checkCell = document.createElement('td'); checkCell.className = 'check-cell';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'row-check'; checkbox.value = incident.recordNo;
      checkbox.setAttribute('aria-label', `${incident.applicantName} ${dateTime(incident.startedAt)} 선택`);
      checkbox.disabled = !canAdvance(incident);
      checkbox.title = checkbox.disabled ? '음원 무결성 문제가 해결되어야 출력할 수 있습니다.' : '';
      checkbox.addEventListener('change', () => changeSelection(incident, checkbox)); checkCell.append(checkbox); row.append(checkCell);
      appendTextCell(row, incident.applicantName); appendTextCell(row, incident.applicantPhone);
      appendTextCell(row, incident.applicantDong); appendTextCell(row, incident.applicantHo);
      appendTextCell(row, dateTime(incident.startedAt)); appendTextCell(row, incident.noiseType); appendTextCell(row, incident.durationOrCount);
      const integrityCell = document.createElement('td'); integrityCell.className = 'integrity-cell';
      integrityCell.append(integrityBadge(incident.integrityStatus)); row.append(integrityCell);
      const action = document.createElement('td'); const detail = document.createElement('button');
      detail.type = 'button'; detail.className = 'detail-button'; detail.textContent = '상세보기';
      detail.setAttribute('aria-expanded', 'false'); detail.addEventListener('click', () => toggleDetail(row, incident, detail));
      action.append(detail); row.append(action); body.append(row);
    });
  }

  function changeSelection(incident, checkbox) {
    if (!canAdvance(incident)) { checkbox.checked = false; return; }
    const currentUser = incidents.find(item => selectedRecords.has(item.recordNo))?.userId;
    if (checkbox.checked && currentUser !== undefined && currentUser !== incident.userId) {
      checkbox.checked = false;
      setMessage($('#dashboardMessage'), '같은 신청세대의 발생일시만 함께 선택할 수 있습니다.');
      return;
    }
    if (checkbox.checked) selectedRecords.add(incident.recordNo); else selectedRecords.delete(incident.recordNo);
    updateSelection();
  }

  function updateSelection() {
    $('#selectionCount').textContent = `${selectedRecords.size}건 선택`;
    $('#printSelected').disabled = selectedRecords.size === 0;
    $('#downloadSelected').disabled = selectedRecords.size === 0;
    const visibleChecks = [...document.querySelectorAll('.row-check:not(:disabled)')];
    $('#selectAll').checked = visibleChecks.length > 0 && visibleChecks.every(check => check.checked);
  }

  $('#selectAll').addEventListener('change', event => {
    document.querySelectorAll('.row-check:not(:disabled)').forEach(check => {
      check.checked = event.currentTarget.checked;
      if (check.checked) selectedRecords.add(check.value); else selectedRecords.delete(check.value);
    });
    updateSelection();
  });

  function detailItem(label, value, wide = false) {
    const item = document.createElement('div'); item.className = `detail-item${wide ? ' wide' : ''}`;
    const caption = document.createElement('span'); caption.textContent = label;
    const content = document.createElement('strong'); content.textContent = value || '확인되지 않음'; item.append(caption, content); return item;
  }

  function labeledControl(labelText, name, value, multiline = false) {
    const label = document.createElement('label'); label.textContent = labelText;
    const control = document.createElement(multiline ? 'textarea' : 'input'); control.name = name;
    control.value = value || ''; control.maxLength = multiline ? 200 : 80;
    if (multiline) control.rows = 3;
    label.append(control); return { label, control };
  }

  function applyIntegrity(row, incident, result) {
    incident.integrityStatus = result.status;
    incident.integrityCheckedAt = result.checkedAt;
    const cell = row.querySelector('.integrity-cell'); if (cell) cell.replaceChildren(integrityBadge(result.status));
    const checkbox = row.querySelector('.row-check');
    if (checkbox) {
      checkbox.disabled = !canAdvance(incident);
      checkbox.title = checkbox.disabled ? '음원 무결성 문제가 해결되어야 출력할 수 있습니다.' : '';
      if (checkbox.disabled) { checkbox.checked = false; selectedRecords.delete(incident.recordNo); }
    }
    const selectable = incidents.filter(canAdvance);
    const userCount = new Set(selectable.map(item => item.userId)).size;
    $('#selectAll').disabled = userCount > 1 || selectable.length === 0;
    $('#selectAll').title = userCount > 1 ? '같은 신청세대의 발생일시만 선택할 수 있습니다.'
      : selectable.length === 0 ? '출력 가능한 무결성 확인 건이 없습니다.' : '';
    updateSelection();
  }

  async function reopenDetail(row, incident, button) {
    const detailRow = row.nextElementSibling;
    if (detailRow?.classList.contains('detail-row')) detailRow.remove();
    const url = audioUrls.get(incident.recordNo);
    if (url) { URL.revokeObjectURL(url); audioUrls.delete(incident.recordNo); }
    button.textContent = '상세보기'; button.setAttribute('aria-expanded', 'false');
    await toggleDetail(row, incident, button);
  }

  async function toggleDetail(row, incident, button) {
    const existing = row.nextElementSibling;
    if (existing?.classList.contains('detail-row')) {
      const url = audioUrls.get(incident.recordNo); if (url) { URL.revokeObjectURL(url); audioUrls.delete(incident.recordNo); }
      existing.remove(); button.textContent = '상세보기'; button.setAttribute('aria-expanded', 'false'); return;
    }
    button.disabled = true;
    try {
      const integrity = await request(`/api/committee/incidents/${incident.recordNo}/integrity-check`, { method: 'POST' });
      applyIntegrity(row, incident, integrity);
      const detail = await request(`/api/committee/incidents/${incident.recordNo}`);
      const audioResponse = await fetch(`/api/committee/incidents/${incident.recordNo}/audio`, { headers: { Authorization: `Bearer ${token}` } });
      if (audioResponse.status === 401) signOut();
      if (!audioResponse.ok) throw new Error('녹음 음원 파일을 불러오지 못했습니다.');
      const audioUrl = URL.createObjectURL(await audioResponse.blob()); audioUrls.set(incident.recordNo, audioUrl);
      const detailRow = document.createElement('tr'); detailRow.className = 'detail-row';
      const cell = document.createElement('td'); cell.colSpan = 10;
      const panel = document.createElement('div'); panel.className = 'detail-panel';
      const audioBox = document.createElement('div');
      const heading = document.createElement('strong'); heading.textContent = `제출 음원 · ${detail.recordNo}`;
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = audioUrl;
      const integrityBox = document.createElement('section');
      integrityBox.className = `integrity-box ${integrityInfo(detail.integrityStatus)[1]}`;
      const integrityHead = document.createElement('div'); integrityHead.className = 'integrity-head';
      const integrityTitle = document.createElement('strong'); integrityTitle.textContent = '음원 원본 무결성';
      const recheck = document.createElement('button'); recheck.type = 'button'; recheck.className = 'secondary compact'; recheck.textContent = '다시 검증';
      recheck.addEventListener('click', async () => {
        recheck.disabled = true;
        try {
          const checked = await request(`/api/committee/incidents/${incident.recordNo}/integrity-check`, { method: 'POST' });
          applyIntegrity(row, incident, checked);
          const message = checked.status === 'MISMATCH_BLOCKED'
            ? `원본 불일치가 확인되었습니다. 앱 알림 ${checked.notificationCreated ? '생성됨' : '기존 알림 유지'}, 이메일 ${checked.emailSent ? '발송됨' : '발송 대기'}.`
            : '음원 원본이 일치합니다.';
          setMessage($('#dashboardMessage'), message, checked.status !== 'MISMATCH_BLOCKED');
          await reopenDetail(row, incident, button);
        } catch (error) { setMessage($('#dashboardMessage'), error.message); }
        finally { recheck.disabled = false; }
      });
      integrityHead.append(integrityTitle, integrityBadge(detail.integrityStatus), recheck);
      const hashes = document.createElement('div'); hashes.className = 'hash-list';
      hashes.append(detailItem('원본 등록 SHA-256', detail.expectedAudioSha256, true),
        detailItem('마지막 검증 원본 SHA-256', detail.currentAudioSha256, true),
        detailItem('제출 음원 등록 SHA-256', detail.submittedAudioSha256, true),
        detailItem('마지막 검증 제출 음원 SHA-256', detail.observedAudioSha256, true),
        detailItem('마지막 검증', detail.integrityCheckedAt ? dateTime(detail.integrityCheckedAt) : '', true));
      integrityBox.append(integrityHead, hashes);

      if (detail.integrityStatus === 'MISMATCH_BLOCKED') {
        const warning = document.createElement('p'); warning.className = 'integrity-warning';
        warning.textContent = '원본 불일치가 해결될 때까지 이 발생일지는 출력·다운로드할 수 없습니다.';
        integrityBox.append(warning);
        if (detail.integrityResolution) integrityBox.append(detailItem('최근 조치 내용', detail.integrityResolution, true));
        if (currentMember?.role === '위원장') {
          const resolutionForm = document.createElement('form'); resolutionForm.className = 'resolution-form';
          const resolution = labeledControl('조치 내용', 'resolution', '', true); resolution.control.maxLength = 1000;
          resolution.control.placeholder = '확인 과정과 주민에게 안내한 재제출 조치를 10자 이상 기록해 주세요.';
          const resolveButton = document.createElement('button'); resolveButton.type = 'submit'; resolveButton.className = 'primary compact'; resolveButton.textContent = '조치 기록';
          resolutionForm.append(resolution.label, resolveButton);
          resolutionForm.addEventListener('submit', async event => {
            event.preventDefault(); resolveButton.disabled = true;
            try {
              const saved = await request(`/api/committee/incidents/${incident.recordNo}/integrity-resolution`, {
                method: 'POST', body: JSON.stringify({ resolution: resolution.control.value.trim() }),
              });
              incident.integrityStatus = saved.status; applyIntegrity(row, incident, { status: saved.status, checkedAt: detail.integrityCheckedAt });
              setMessage($('#dashboardMessage'), `조치 내용을 기록했습니다. 일치하는 음원을 다시 제출할 때까지 출력은 차단됩니다. 주민 알림 생성, 이메일 ${saved.emailSent ? '발송 완료' : '발송 실패 기록'}.`, true);
              await reopenDetail(row, incident, button);
            } catch (error) { setMessage($('#dashboardMessage'), error.message); }
            finally { resolveButton.disabled = false; }
          });
          integrityBox.append(resolutionForm);
        }
      }

      audioBox.append(heading, audio, integrityBox);
      const grid = document.createElement('div'); grid.className = 'detail-grid';
      grid.append(
        detailItem('녹음 시작', dateTime(detail.startedAt)), detailItem('녹음 종료', dateTime(detail.endedAt)),
        detailItem('최소 데시벨', detail.minDb ? `${detail.minDb} dBFS` : ''), detailItem('최대 데시벨', detail.maxDb ? `${detail.maxDb} dBFS` : ''),
        detailItem('녹음위치 위도', detail.latitude), detailItem('녹음위치 경도', detail.longitude),
        detailItem('IP', detail.ip), detailItem('상대세대 입주자명', detail.otherName),
        detailItem('상대세대 동·호수', [detail.otherDong && `${detail.otherDong}동`, detail.otherHo && `${detail.otherHo}호`].filter(Boolean).join(' ')),
        detailItem('발생추정장소', detail.estimatedPlace, true), detailItem('피해사례', detail.damage, true),
      );
      const counterpartForm = document.createElement('form'); counterpartForm.className = 'counterpart-form';
      const counterpartTitle = document.createElement('h3'); counterpartTitle.textContent = '상대세대 사후 확인 정보';
      const counterpartHelp = document.createElement('p'); counterpartHelp.className = 'muted';
      counterpartHelp.textContent = '정보가 없거나 달라진 경우 위원회 확인 결과를 입력하세요. 모든 변경은 이력으로 보존됩니다.';
      const name = labeledControl('입주자명', 'name', detail.otherName);
      const dong = labeledControl('동', 'dong', detail.otherDong); const ho = labeledControl('호수', 'ho', detail.otherHo);
      const place = labeledControl('발생추정장소', 'estimatedPlace', detail.estimatedPlace, true);
      const saveCounterpart = document.createElement('button'); saveCounterpart.type = 'submit'; saveCounterpart.className = 'primary compact'; saveCounterpart.textContent = '상대세대 정보 저장';
      const audit = document.createElement('p'); audit.className = 'audit-note';
      audit.textContent = detail.counterpartUpdatedAt
        ? `마지막 수정: ${detail.counterpartUpdatedBy || '위원회'} · ${dateTime(detail.counterpartUpdatedAt)}` : '위원회 수정 이력이 없습니다.';
      counterpartForm.append(counterpartTitle, counterpartHelp, name.label, dong.label, ho.label, place.label, saveCounterpart, audit);
      counterpartForm.addEventListener('submit', async event => {
        event.preventDefault(); saveCounterpart.disabled = true;
        try {
          const saved = await request(`/api/committee/incidents/${incident.recordNo}/counterpart`, {
            method: 'PUT', body: JSON.stringify({ name: name.control.value.trim(), dong: dong.control.value.trim(),
              ho: ho.control.value.trim(), estimatedPlace: place.control.value.trim() }),
          });
          audit.textContent = `마지막 수정: ${saved.updatedBy || '위원회'} · ${dateTime(saved.updatedAt)}`;
          setMessage($('#dashboardMessage'), '상대세대 확인 정보를 저장하고 변경 이력을 남겼습니다.', true);
          await reopenDetail(row, incident, button);
        } catch (error) { setMessage($('#dashboardMessage'), error.message); }
        finally { saveCounterpart.disabled = false; }
      });
      panel.append(audioBox, grid, counterpartForm); cell.append(panel); detailRow.append(cell); row.after(detailRow);
      button.textContent = '상세닫기'; button.setAttribute('aria-expanded', 'true');
    } catch (error) { setMessage($('#dashboardMessage'), error.message); }
    finally { button.disabled = false; }
  }

  async function exportSelected(download) {
    const popup = download ? null : window.open('', '_blank');
    try {
      const result = await requestBlob('/api/committee/export', { recordNos: [...selectedRecords], download });
      const url = URL.createObjectURL(result.blob);
      if (download) {
        const encoded = /filename\*=UTF-8''([^;]+)/i.exec(result.disposition)?.[1];
        const link = document.createElement('a'); link.href = url;
        link.download = encoded ? decodeURIComponent(encoded) : '층간소음발생일지.pdf';
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } else if (popup) {
        popup.location.href = url; setTimeout(() => { try { popup.print(); } catch { /* PDF viewer provides print */ } }, 1_500);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (error) { if (popup) popup.close(); setMessage($('#dashboardMessage'), error.message); }
  }
  $('#printSelected').addEventListener('click', () => exportSelected(false));
  $('#downloadSelected').addEventListener('click', () => exportSelected(true));

  if (token) openDashboard();
})();
