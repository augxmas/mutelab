(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const tokenKey = 'mutelabCommitteeToken';
  const rememberedLoginKey = 'mutelabCommitteeLoginId';
  let token = sessionStorage.getItem(tokenKey) || '';
  const sessionWarning = $('#committeeSessionWarning');
  const loginHistory = $('#committeeLoginHistory');
  const notificationsDialog = $('#committeeNotifications');
  let notificationTimer;
  let notificationRequest = 0;
  let sessionDeadline = 0;
  let sessionTimer;
  let loggingOut = false;
  let loginChallenge = '';
  let loginIdToRemember = '';
  let selectedApartment = null;
  let signupEmail = '';
  let signupVerificationToken = '';
  let signupDocumentFile = null;
  let incidents = [];
  let currentMember = null;
  let incidentLoad = null;
  let reportAvailable = false;
  let reportSubmitting = false;
  let selectedReportKey = null;
  const selectedReports = new Map();
  const selectedIncidentDeletes = new Set();
  let deletingIncidents = false;
  let deletingReports = false;
  let sortField = 'startedAt';
  let sortDirection = -1;
  const selectedRecords = new Set();
  const incidentDialog = $('#incidentDialog');
  const incidentDialogContent = $('#incidentDialogContent');
  let detailView = null;

  function setDetailMessage(message, success = false) {
    const status = $('#incidentDialogMessage');
    status.hidden = !message;
    setMessage(status, message, success);
  }

  function clearDetail() {
    detailView?.controller.abort();
    if (detailView?.audioUrl) URL.revokeObjectURL(detailView.audioUrl);
    detailView = null;
    incidentDialogContent.replaceChildren();
  }

  incidentDialog.addEventListener('close', () => {
    if (!incidentDialog.open) clearDetail();
  });

  function checkSessionClock() {
    clearTimeout(sessionTimer);
    if (!token || !sessionDeadline) return;
    const remaining = sessionDeadline - Date.now();
    if (remaining <= 0) {
      signOut('세션이 만료되었습니다. 다시 로그인해 주세요.');
      return;
    }
    if (remaining <= 60_000) {
      if (!sessionWarning.open) {
        $('#committeeSessionMessage').hidden = true;
        sessionWarning.showModal();
      }
      sessionTimer = setTimeout(checkSessionClock, remaining);
    } else {
      if (sessionWarning.open) sessionWarning.close();
      sessionTimer = setTimeout(checkSessionClock, remaining - 60_000);
    }
  }

  async function committeeFetch(path, options = {}) {
    const sessionToken = token;
    const headers = new Headers(options.headers || {});
    if (sessionToken) headers.set('Authorization', `Bearer ${sessionToken}`);
    const started = Date.now();
    const response = await fetch(path, { ...options, headers });
    if (sessionToken && sessionToken === token && path.startsWith('/api/committee/') && !path.includes('/login')) {
      if (response.status === 401) signOut('세션이 종료되었습니다. 다시 로그인해 주세요.');
      else {
        const expires = Number(response.headers.get('X-Committee-Session-Expires'));
        const serverNow = Number(response.headers.get('X-Committee-Session-Now'));
        if (expires > serverNow && serverNow > 0) {
          sessionDeadline = Math.max(sessionDeadline, started + expires - serverNow);
          checkSessionClock();
        }
      }
    }
    return response;
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await committeeFetch(path, { ...options, headers });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
      const error = new Error(payload?.error || '요청을 처리하지 못했습니다.');
      error.code = payload?.code;
      error.skippedReasons = payload?.skippedReasons;
      error.retryAfter = response.status === 429 ? Number(response.headers.get('Retry-After')) : 0;
      throw error;
    }
    return payload;
  }

  async function requestBlob(path, body, signal) {
    const response = await committeeFetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) {
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

  function setupSignatureEditor(container) {
    container.append($('#committeeSignatureTemplate').content.cloneNode(true));
    const canvas = container.querySelector('canvas');
    const context = canvas.getContext('2d');
    const fileInput = container.querySelector('input');
    const status = container.querySelector('[role="status"]');
    let revision = 0, dirty = false, hasImage = false, loading = false, activePointer = null, drawing = false;
    const message = value => { status.hidden = !value; setMessage(status, value); };
    function drawImage(image, width, height) {
      const scale = Math.min(canvas.width / width, canvas.height / height, 1);
      const w = width * scale, h = height * scale;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      hasImage = true;
      drawing = false;
    }
    function reset(base64 = null) {
      const current = ++revision;
      activePointer = null; dirty = false; hasImage = false; drawing = false; loading = Boolean(base64);
      fileInput.value = '';
      context.clearRect(0, 0, canvas.width, canvas.height);
      message('');
      if (!base64) return;
      const image = new Image();
      image.onload = () => {
        if (current !== revision) return;
        drawImage(image, image.naturalWidth, image.naturalHeight);
        loading = false;
      };
      image.onerror = () => {
        if (current !== revision) return;
        loading = false;
        message('저장된 이미지를 표시할 수 없습니다.');
      };
      image.src = 'data:image/png;base64,' + base64;
    }
    const point = event => {
      const bounds = canvas.getBoundingClientRect();
      return [(event.clientX - bounds.left) * canvas.width / bounds.width,
        (event.clientY - bounds.top) * canvas.height / bounds.height];
    };
    canvas.addEventListener('pointerdown', event => {
      if (loading || activePointer !== null || event.button !== 0) return;
      if (!drawing) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        drawing = true;
      }
      activePointer = event.pointerId;
      canvas.setPointerCapture(activePointer);
      const [x, y] = point(event);
      context.fillStyle = '#14243b'; context.strokeStyle = '#14243b';
      context.lineWidth = 4; context.lineCap = 'round'; context.lineJoin = 'round';
      context.beginPath(); context.arc(x, y, 2, 0, Math.PI * 2); context.fill();
      context.beginPath(); context.moveTo(x, y);
      dirty = true; hasImage = true;
      message('');
    });
    canvas.addEventListener('pointermove', event => {
      if (event.pointerId === activePointer) {
        context.lineTo(...point(event));
        context.stroke();
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, event => { if (event.pointerId === activePointer) activePointer = null; });
    }
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileInput.value = '';
      if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) {
        message('5MB 이하의 PNG 또는 JPG 파일을 선택해 주세요.');
        return;
      }
      const current = ++revision;
      activePointer = null; loading = true;
      try {
        const image = await createImageBitmap(file);
        if (current === revision) { drawImage(image, image.width, image.height); dirty = true; message(''); }
        image.close();
      } catch {
        if (current === revision) message('이미지 파일을 읽을 수 없습니다.');
      } finally {
        if (current === revision) loading = false;
      }
    });
    container.querySelector('button').addEventListener('click', () => {
      reset();
      dirty = true;
    });
    return {
      reset,
      value() {
        if (loading) throw new Error('이미지를 불러오는 중입니다. 잠시 후 저장해 주세요.');
        if (!dirty) return undefined;
        if (!hasImage) return null;
        const data = canvas.toDataURL('image/png').split(',')[1];
        if (data.length > 349528) throw new Error('저장 이미지가 256KB를 넘습니다. 더 작은 이미지를 선택해 주세요.');
        return data;
      },
    };
  }

  const signupSignature = setupSignatureEditor($('#signupSignature'));
  const settingsSignature = setupSignatureEditor($('#settingsSignature'));

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
    const allowedTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    const allowedExtension = /\.(pdf|png|jpe?g|gif|webp)$/i.test(file.name);
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
      clearDocumentFile('PDF, PNG, JPEG, GIF, WebP 파일을 첨부해 주세요.', true);
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
    signupEmail = '';
    signupVerificationToken = '';
    $('#apartmentForm').reset();
    resetApartmentSearch();
    $('#emailStartForm').reset();
    updateEmailRequestButton();
    $('#emailVerifyForm').reset();
    $('#emailVerifyForm').hidden = true;
    $('#verifyEmailCode').hidden = true;
    $('#signupForm').reset();
    signupSignature.reset();
    $('#signupMobile').setCustomValidity('');
    $('#signupContact').setCustomValidity('');
    $('#signupBaseAddress').value = '';
    clearDocumentFile();
    setMessage($('#signupEmailMessage'), '');
    setMessage($('#signupMessage'), '');
    setSignupStep(1);
    $('#signupDialog').showModal();
  });

  const apartmentQuery = $('#apartmentQuery');
  const apartmentResults = $('#apartmentResults');
  const apartmentStatus = $('#apartmentSearchStatus');
  let apartmentSearchTimer;
  let apartmentSearchRequest;

  function setApartmentStatus(message) {
    apartmentStatus.textContent = message;
    apartmentStatus.hidden = !message;
  }

  function resetApartmentSearch() {
    clearTimeout(apartmentSearchTimer);
    apartmentSearchRequest?.abort();
    apartmentResults.replaceChildren();
    selectedApartment = null;
    $('#toEmailStep').disabled = true;
    $('#signupBaseAddress').value = '';
    setApartmentStatus('');
  }

  async function searchApartments(query) {
    const controller = new AbortController();
    apartmentSearchRequest = controller;
    setApartmentStatus('등록 단지를 검색하는 중입니다.');
    try {
      const data = await request(`/api/committee/apartments?name=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (controller.signal.aborted || !$('#signupDialog').open) return;
      setApartmentStatus(data.apartments.length ? '' : '검색된 등록 단지가 없습니다.');
      data.apartments.forEach(apartment => {
        const option = document.createElement('button');
        option.type = 'button'; option.className = 'apartment-option'; option.setAttribute('aria-pressed', 'false');
        const name = document.createElement('strong'); name.textContent = apartment.kaptName;
        const address = document.createElement('span'); address.textContent = apartment.address || '주소 정보 없음';
        option.append(name, address);
        option.addEventListener('click', () => {
          selectedApartment = apartment;
          apartmentResults.querySelectorAll('.apartment-option').forEach(button => {
            button.classList.toggle('selected', button === option);
            button.setAttribute('aria-pressed', String(button === option));
          });
          $('#signupBaseAddress').value = apartment.address || '';
          $('#toEmailStep').disabled = false;
        });
        apartmentResults.append(option);
      });
    } catch (error) {
      if (!controller.signal.aborted && $('#signupDialog').open) setApartmentStatus(error.message);
    }
  }

  function queueApartmentSearch(event) {
    resetApartmentSearch();
    const query = apartmentQuery.value.trim();
    if (event.isComposing || query.length < 2) return;
    apartmentSearchTimer = setTimeout(() => searchApartments(query), 300);
  }

  apartmentQuery.addEventListener('input', queueApartmentSearch);
  apartmentQuery.addEventListener('compositionend', queueApartmentSearch);
  $('#apartmentForm').addEventListener('submit', event => {
    event.preventDefault();
    resetApartmentSearch();
    const query = apartmentQuery.value.trim();
    if (query.length >= 2) searchApartments(query);
    else setApartmentStatus('단지명을 두 글자 이상 입력해 주세요.');
  });
  $('#signupDialog').addEventListener('close', () => {
    if (!$('#signupDialog').open) resetApartmentSearch();
  });

  $('#toEmailStep').addEventListener('click', () => {
    if (!selectedApartment) return;
    $('#selectedApartmentText').textContent = `${selectedApartment.kaptName} · ${selectedApartment.address || ''}`;
    $('#signupBaseAddress').value = selectedApartment.address || '';
    setSignupStep(2);
  });

  const signupEmailInput = $('#signupEmail');
  const requestEmailCode = $('#requestEmailCode');
  let signupEmailRequest = null;
  let emailRetryTimer;
  const emailRetryUntil = new Map();

  function updateEmailRequestButton() {
    clearTimeout(emailRetryTimer);
    const email = signupEmailInput.value.trim().toLowerCase();
    const wait = Math.max(0, Math.ceil(((emailRetryUntil.get(email) ?? 0) - Date.now()) / 1000));
    requestEmailCode.disabled = Boolean(signupEmailRequest) || wait > 0;
    requestEmailCode.textContent = signupEmailRequest ? '발송 중…' : wait ? `다시 받기 (${wait}초)` : '인증코드 받기';
    if (wait) emailRetryTimer = setTimeout(updateEmailRequestButton, 1000);
  }

  signupEmailInput.addEventListener('input', () => {
    if (signupEmailInput.value.trim().toLowerCase() !== signupEmail) {
      signupEmail = '';
      $('#emailVerifyForm').reset();
      $('#emailVerifyForm').hidden = true;
      $('#verifyEmailCode').hidden = true;
      setMessage($('#signupEmailMessage'), '');
    }
    updateEmailRequestButton();
  });

  $('#emailStartForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (requestEmailCode.disabled) return;
    const email = signupEmailInput.value.trim().toLowerCase();
    const controller = new AbortController();
    signupEmailRequest = controller;
    updateEmailRequestButton();
    try {
      const data = await request('/api/auth/email/start', {
        method: 'POST', body: JSON.stringify({ email, purpose: 'committee-signup' }), signal: controller.signal,
      });
      emailRetryUntil.set(email, Date.now() + 45_000);
      if (signupEmailRequest !== controller || !$('#signupDialog').open
          || signupEmailInput.value.trim().toLowerCase() !== email) return;
      signupEmail = email;
      $('#emailVerifyForm').reset();
      $('#emailVerifyForm').hidden = false;
      $('#verifyEmailCode').hidden = false;
      setMessage($('#signupEmailMessage'), data.message, true);
      requestAnimationFrame(() => {
        if ($('#signupDialog').open && !$('#signupStep2').hidden && !$('#emailVerifyForm').hidden) $('#signupEmailCode').focus();
      });
    } catch (error) {
      if (error.retryAfter > 0) emailRetryUntil.set(email, Date.now() + error.retryAfter * 1000);
      if (!controller.signal.aborted && $('#signupDialog').open
          && signupEmailInput.value.trim().toLowerCase() === email) setMessage($('#signupEmailMessage'), error.message);
    } finally {
      if (signupEmailRequest === controller) signupEmailRequest = null;
      updateEmailRequestButton();
    }
  });

  $('#signupDialog').addEventListener('close', () => {
    if (!$('#signupDialog').open) {
      signupEmailRequest?.abort();
      signupEmailRequest = null;
      updateEmailRequestButton();
    }
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
        documentName: file.name, document: await fileAsBase64(file), signature: signupSignature.value(),
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

  const loginIdInput = $('#loginId');
  const rememberLogin = $('#rememberLoginId');
  try {
    loginIdInput.value = localStorage.getItem(rememberedLoginKey) || '';
    rememberLogin.checked = Boolean(loginIdInput.value);
  } catch { /* Login remains available when browser storage is blocked. */ }

  rememberLogin.addEventListener('change', () => {
    if (!rememberLogin.checked) {
      try { localStorage.removeItem(rememberedLoginKey); } catch { /* Browser storage is blocked. */ }
    }
  });

  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const loginId = loginIdInput.value.trim();
    const remember = rememberLogin.checked;
    try {
      const data = await request('/api/committee/login', {
        method: 'POST', body: JSON.stringify({ loginId, password: $('#loginPassword').value }),
      });
      loginChallenge = data.challengeId;
      loginIdToRemember = remember ? loginId : '';
      const otpForm = $('#loginOtpForm');
      otpForm.reset();
      $('#loginForm').hidden = true;
      otpForm.hidden = false;
      setMessage($('#authMessage'), data.message, true);
      requestAnimationFrame(() => {
        if (!otpForm.hidden && loginChallenge === data.challengeId) $('#loginOtp').focus();
      });
    } catch (error) { setMessage($('#authMessage'), error.message); }
  });

  $('#loginBack').addEventListener('click', () => {
    loginChallenge = ''; loginIdToRemember = ''; $('#loginOtpForm').reset(); $('#loginOtpForm').hidden = true; $('#loginForm').hidden = false;
    setMessage($('#authMessage'), '');
  });

  $('#loginOtpForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = await request('/api/committee/login/verify', {
        method: 'POST', body: JSON.stringify({ challengeId: loginChallenge, code: $('#loginOtp').value.trim() }),
      });
      try {
        if (loginIdToRemember) localStorage.setItem(rememberedLoginKey, loginIdToRemember);
        else localStorage.removeItem(rememberedLoginKey);
      } catch { /* The authenticated session does not depend on remembering the ID. */ }
      loginIdToRemember = '';
      token = data.token; sessionStorage.setItem(tokenKey, token);
      sessionDeadline = Date.now() + data.idleSeconds * 1000;
      checkSessionClock();
      await openDashboard();
      if (token === data.token) showLoginHistory(data.login, data.previousLogin);
    } catch (error) { setMessage($('#authMessage'), error.message); }
  });

  function signOut(message = '') {
    token = ''; currentMember = null; sessionStorage.removeItem(tokenKey); selectedRecords.clear(); selectedReports.clear(); selectedReportKey = null;
    sessionDeadline = 0;
    clearTimeout(sessionTimer);
    if (sessionWarning.open) sessionWarning.close();
    if (loginHistory.open) loginHistory.close();
    clearInterval(notificationTimer);
    notificationRequest++;
    $('#committeeNotificationCount').hidden = true;
    if (notificationsDialog.open) notificationsDialog.close();
    $('#committeeNotificationList').replaceChildren();
    $('#committeeInquiryList').replaceChildren();
    $('#committeeInquiryForm').reset();
    selectedIncidentDeletes.clear();
    if ($('#reportConfirmation').open) $('#reportConfirmation').close('cancel');
    if ($('#deleteConfirmation').open) $('#deleteConfirmation').close('cancel');
    incidentLoad?.abort();
    if (incidentDialog.open) incidentDialog.close();
    if ($('#incidentLogPreview').open) closeLogPreview();
    if ($('#mediationConfirmation').open) $('#mediationConfirmation').close();
    if ($('#mediationDialog').open) closeMediationDialog();
    if ($('#visitDialog').open) visitApplications.close();
    if ($('#measurementDialog').open) measurementApplications.close();
    closeMemberSettings(false);
    clearDetail();
    $('#dashboard').hidden = true; $('#authView').hidden = false;
    $('#loginOtpForm').hidden = true; $('#loginForm').hidden = false; $('#loginPassword').value = '';
    setMessage($('#authMessage'), message);
  }

  async function logoutCommittee() {
    if (!token || loggingOut) return;
    const sessionToken = token;
    loggingOut = true;
    try {
      await request('/api/committee/session/logout', { method: 'POST', signal: AbortSignal.timeout(5000) });
    } catch {
      // A disconnected session expires on the server at its existing deadline.
    } finally {
      loggingOut = false;
      if (sessionToken === token) signOut();
    }
  }

  function showLoginHistory(current, previous) {
    $('#committeeCurrentLoginTime').textContent = dateTime(current.loggedInAt);
    $('#committeeCurrentLoginIp').textContent = current.ip || '-';
    $('#committeePreviousLoginTime').textContent = previous ? dateTime(previous.loggedInAt) : '기록 없음';
    $('#committeePreviousLoginIp').textContent = previous?.ip || '-';
    $('#committeePreviousLogoutTime').textContent = previous?.loggedOutAt ? dateTime(previous.loggedOutAt)
      : previous ? '아직 종료되지 않음' : '-';
    loginHistory.showModal();
  }

  $('#logout').addEventListener('click', logoutCommittee);
  $('#sessionLogout').addEventListener('click', logoutCommittee);
  sessionWarning.addEventListener('cancel', event => event.preventDefault());
  $('#extendSession').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (button.disabled || loggingOut) return;
    button.disabled = true;
    try {
      await request('/api/committee/session/extend', { method: 'POST', signal: AbortSignal.timeout(5000) });
    } catch (error) {
      if (sessionWarning.open) {
        const message = $('#committeeSessionMessage');
        setMessage(message, error.message);
        message.hidden = false;
      }
    } finally { button.disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSessionClock(); });

  function showMemberSummary(me) {
    currentMember = me.current || null;
    const representative = me.representative ? `위원장 ${me.representative.name}` : '위원장 미등록';
    const title = document.createElement('strong'); title.textContent = me.complex?.kaptName || '위원회';
    const line = document.createElement('span'); line.textContent = `${me.members.length}명 · ${representative}`;
    $('#memberSummary').replaceChildren(title, line);
  }

  async function openDashboard() {
    $('#authView').hidden = true; $('#dashboard').hidden = false;
    try {
      const me = await request('/api/committee/me');
      showMemberSummary(me);
      clearInterval(notificationTimer);
      notificationTimer = setInterval(() => {
        if (!document.hidden && token) loadCommitteeNotifications(true).catch(() => {});
      }, 30_000);
      await Promise.all([loadCommitteeNotifications(), loadIncidents(),
        committeePanel.dataset.view === 'inquiries' ? loadCommitteeInquiries() : null]);
    } catch (error) {
      setMessage($('#dashboardMessage'), error.message);
    }
  }

  async function loadCommitteeNotifications(passive = false) {
    if (passive && notificationsDialog.open) return;
    const load = passive ? notificationRequest : ++notificationRequest;
    const session = token;
    const data = await request(passive ? '/api/committee/notification-updates' : '/api/committee/notifications');
    if (!session || session !== token || load !== notificationRequest) return;
    const badge = $('#committeeNotificationCount');
    badge.textContent = String(data.unreadCount);
    badge.hidden = !data.unreadCount;
    $('#openCommitteeNotifications').setAttribute('aria-label', data.unreadCount ? `읽지 않은 알림 ${data.unreadCount}건` : '알림');
    if (passive || !notificationsDialog.open) return;
    const list = $('#committeeNotificationList');
    list.replaceChildren();
    if (!data.notifications.length) list.textContent = '받은 알림이 없습니다.';
    for (const notification of data.notifications) {
      const article = document.createElement('article');
      article.className = `committee-notification ${notification.decision === 'REJECTED' ? 'rejected' : 'approved'}`;
      const copy = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = notification.title || '위원회 처리 결과';
      const message = document.createElement('p'); message.textContent = notification.message || '';
      const time = document.createElement('time');
      const createdAt = new Date(notification.createdAt);
      time.textContent = Number.isNaN(createdAt.getTime()) ? '' : createdAt.toLocaleString('ko-KR');
      copy.append(title, message, time);
      const read = document.createElement('button'); read.type = 'button'; read.className = 'secondary compact'; read.textContent = '확인';
      read.hidden = Boolean(notification.readAt);
      read.addEventListener('click', async () => {
        read.disabled = true;
        try {
          const target = notification.kind === 'inquiry' ? 'inquiries' : 'notifications';
          await request(`/api/committee/${target}/${notification.notificationId}/read`, { method: 'POST' });
          await loadCommitteeNotifications();
        } catch (error) {
          read.disabled = false;
          mediationStatus($('#committeeNotificationMessage'), error.message);
        }
      });
      article.append(copy, read); list.append(article);
    }
  }

  $('#openCommitteeNotifications').addEventListener('click', async () => {
    $('#committeeNotificationList').replaceChildren();
    const message = $('#committeeNotificationMessage');
    mediationStatus(message, '알림을 불러오는 중입니다.');
    notificationsDialog.showModal();
    try { await loadCommitteeNotifications(); mediationStatus(message, ''); }
    catch (error) { mediationStatus(message, error.message); }
  });

  const inquiryForm = $('#committeeInquiryForm');
  const inquiryMessage = $('#committeeInquiryMessage');
  function inquiryText(tag, value) {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
  }

  async function loadCommitteeInquiries() {
    const session = token;
    try {
      const { inquiries } = await request('/api/committee/inquiries');
      if (!session || session !== token) return;
      const list = $('#committeeInquiryList');
      list.replaceChildren();
      if (!inquiries.length) list.textContent = '등록된 문의가 없습니다.';
      for (const inquiry of inquiries) {
        const card = document.createElement('article');
        const time = inquiryText('p', `${dateTime(inquiry.createdAt)} · ${inquiry.repliedAt ? '답변 완료' : '답변 대기'}`);
        time.className = 'muted';
        card.append(inquiryText('h3', inquiry.title), time, inquiryText('p', inquiry.content));
        if (inquiry.hasImage) {
          const attachment = inquiryText('button', '첨부 이미지 보기');
          attachment.type = 'button'; attachment.className = 'secondary compact';
          attachment.addEventListener('click', async () => {
            attachment.disabled = true;
            try {
              const response = await committeeFetch(`/api/committee/inquiries/${inquiry.id}/image`);
              if (!response.ok) throw new Error('첨부 이미지를 불러오지 못했습니다.');
              const blob = await response.blob();
              const bytes = await fileAsBase64(blob);
              if (session !== token) return;
              const image = document.createElement('img');
              image.alt = '문의 첨부 이미지';
              image.src = `data:${blob.type};base64,${bytes}`;
              attachment.replaceWith(image);
            } catch (error) { mediationStatus(inquiryMessage, error.message); attachment.disabled = false; }
          });
          card.append(attachment);
        }
        if (inquiry.reply) card.append(inquiryText('h4', '답변'), inquiryText('p', inquiry.reply));
        list.append(card);
      }
    } catch (error) { mediationStatus(inquiryMessage, error.message); }
  }

  inquiryForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#saveCommitteeInquiry');
    if (button.disabled) return;
    const { title, content, image } = Object.fromEntries(new FormData(inquiryForm));
    if (image.size > 2 * 1024 * 1024) {
      mediationStatus(inquiryMessage, '첨부 이미지는 2MB 이하여야 합니다.');
      return;
    }
    button.disabled = true;
    try {
      await request('/api/committee/inquiries', {
        method: 'POST', headers: { 'Content-Type': 'application/vnd.mutelab.inquiry+json' },
        body: JSON.stringify({ title, content, image: image.size ? await fileAsBase64(image) : null }),
      });
      inquiryForm.reset();
      mediationStatus(inquiryMessage, '문의를 등록했습니다.', true);
      await loadCommitteeInquiries();
    } catch (error) { mediationStatus(inquiryMessage, error.message); }
    finally { button.disabled = false; }
  });

  function filtersQuery(filterForm) {
    const form = new FormData(filterForm);
    const params = new URLSearchParams();
    for (const [key, value] of form) if (String(value).trim()) params.set(key, String(value).trim());
    return params;
  }

  const incidentDate = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  });

  async function loadIncidents() {
    incidentLoad?.abort();
    const controller = new AbortController();
    incidentLoad = controller;
    setMessage($('#dashboardMessage'), '');
    try {
      const filters = filtersQuery($('#filters'));
      const from = filters.get('startedFrom');
      const to = filters.get('startedTo');
      if (from && to && from > to) throw new Error('시작일은 종료일보다 늦을 수 없습니다.');
      filters.delete('startedFrom');
      filters.delete('startedTo');
      const data = await request(`/api/committee/incidents?${filters}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      reportAvailable = data.reportAvailable === true;
      incidents = from || to ? data.incidents.filter(incident => {
        const date = incidentDate.format(new Date(incident.startedAt));
        return (!from || date >= from) && (!to || date <= to);
      }) : data.incidents;
      selectedRecords.clear(); selectedReports.clear(); selectedIncidentDeletes.clear(); selectedReportKey = null; renderRows();
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }

  $('#filters').addEventListener('submit', event => { event.preventDefault(); loadIncidents().catch(error => setMessage($('#dashboardMessage'), error.message)); });
  $('#resetFilters').addEventListener('click', () => { $('#filters').reset(); loadIncidents().catch(error => setMessage($('#dashboardMessage'), error.message)); });

  const committeePanel = $('#committeePanel');
  const committeeTabs = [...document.querySelectorAll('.committee-tab')];
  const viewTitles = {
    reports: '층간소음보고서 출력 대상',
    applicants: '신청세대 발생일지',
    counterparts: '상대세대 발생일지',
  };

  function selectCommitteeTab(tab, success = '', reload = true) {
    const view = tab.dataset.view;
    if (committeePanel.dataset.view === view) return;
    committeePanel.dataset.view = view;
    const showDocuments = view === 'documents';
    const showMediation = view === 'mediation';
    const showVisit = view === 'visit';
    const showMeasurement = view === 'measurement';
    const showInquiries = view === 'inquiries';
    committeePanel.hidden = showDocuments || showMediation || showVisit || showMeasurement || showInquiries;
    $('#documentsPanel').hidden = !showDocuments;
    $('#mediationPanel').hidden = !showMediation;
    $('#visitPanel').hidden = !showVisit;
    $('#measurementPanel').hidden = !showMeasurement;
    $('#inquiriesPanel').hidden = !showInquiries;
    for (const item of committeeTabs) {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    if (showDocuments) return;
    if (showInquiries) { loadCommitteeInquiries(); return; }
    if (showMediation) { loadMediationReports(success); return; }
    if (showVisit) { visitApplications.load(success); return; }
    if (showMeasurement) { measurementApplications.load(success); return; }
    committeePanel.setAttribute('aria-labelledby', tab.id);
    const gridTitle = $('#gridTitle');
    gridTitle.textContent = viewTitles[view] ?? '';
    gridTitle.hidden = !viewTitles[view];
    const householdView = view === 'applicants' || view === 'counterparts';
    for (const fieldset of $('#filters').querySelectorAll('[data-household]')) {
      const hide = householdView && fieldset.dataset.household !== view;
      fieldset.hidden = hide;
      fieldset.disabled = hide;
    }
    selectedRecords.clear();
    selectedReports.clear();
    selectedIncidentDeletes.clear();
    selectedReportKey = null;
    renderRows();
    if (reload) loadIncidents().catch(error => setMessage($('#dashboardMessage'), error.message));
  }

  $('.committee-tabs').addEventListener('click', event => {
    const tab = event.target.closest('[role="tab"]');
    if (tab) selectCommitteeTab(tab);
  });

  $('#committeeDocuments').addEventListener('click', async event => {
    const button = event.target.closest('[data-document-id]');
    if (!button) return;
    const status = $('#committeeDocumentsMessage');
    status.hidden = true;
    const popup = window.open('', '_blank');
    if (!popup) {
      status.hidden = false;
      setMessage(status, '팝업을 허용한 뒤 문서를 다시 열어 주세요.');
      return;
    }
    popup.opener = null;
    button.disabled = true;
    try {
      const response = await committeeFetch(`/api/committee/documents/${button.dataset.documentId}`);
      if (!response.ok) throw new Error('PDF를 불러오지 못했습니다. 다시 시도해 주세요.');
      const blob = await response.blob();
      if (popup.closed) return;
      const url = URL.createObjectURL(blob);
      popup.location.href = url;
      const watch = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(watch);
        URL.revokeObjectURL(url);
      }, 2000);
    } catch (error) {
      popup.close();
      status.hidden = false;
      setMessage(status, error.message);
    } finally {
      button.disabled = false;
    }
  });
  $('.committee-tabs').addEventListener('keydown', event => {
    const index = committeeTabs.indexOf(event.target);
    if (index < 0) return;
    const last = committeeTabs.length - 1;
    const next = {
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowRight: index === last ? 0 : index + 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    committeeTabs[next].focus();
    selectCommitteeTab(committeeTabs[next]);
  });

  function appendTextCell(row, value, column) {
    const cell = document.createElement('td'); cell.textContent = value || '-';
    if (value) cell.title = value;
    if (column) cell.dataset.column = column;
    row.append(cell); return cell;
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

  const deleteIncidents = $('#deleteIncidents');
  const reportDialog = $('#reportConfirmation');
  const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
  const selectedJournalRows = () => incidents.filter(incident => incident.residentSelected);
  const printIncidentLog = $('#printIncidentLog');
  const previewReportedIncidentLog = $('#previewReportedIncidentLog');
  const writeMediationReport = $('#writeMediationReport');
  const writeVisitApplication = $('#writeVisitApplication');
  const writeMeasurementApplication = $('#writeMeasurementApplication');
  const reportGroupView = () => reportAvailable && committeePanel.dataset.view === 'reports';
  let reportConfirmation;

  function reportSkippedReasons(reasons = {}) {
    const lines = [];
    if (reasons.unconfirmed) lines.push(`상대세대 미확인 ${reasons.unconfirmed}건. 사후 확인 정보에 입주자명과 호수를 저장해 주세요.`);
    if (reasons.alreadyReported) lines.push(`이미 보고서에 포함된 발생일지 ${reasons.alreadyReported}건.`);
    if (reasons.unavailable) lines.push(`철회되었거나 조회할 수 없는 발생일지 ${reasons.unavailable}건.`);
    return lines;
  }

  function showReportResult(title, message, reasons) {
    $('#reportResultTitle').textContent = title;
    $('#reportResultMessage').textContent = [message, ...reportSkippedReasons(reasons)].join('\n');
    const dialog = $('#reportResult');
    if (!dialog.open) dialog.showModal();
  }

  reportDialog.querySelector('form').addEventListener('submit', async event => {
    if (event.submitter?.value !== 'submit' || !reportConfirmation || reportSubmitting) return;
    event.preventDefault();
    const { recordNos, fromPreview } = reportConfirmation;
    reportConfirmation = undefined;
    reportDialog.close('submit');
    reportSubmitting = true; updateSelection();
    try {
      const result = await request('/api/committee/reports', {
        method: 'POST', body: JSON.stringify({ recordNos }),
      });
      if (!token) return;
      const summary = `발생일지 ${result.added}건을 보고서 ${result.reports}건에 반영했습니다.`;
      if (fromPreview && result.added) {
        closeLogPreview();
        selectCommitteeTab($('#reportsTab'), '', false);
        $('#reportsTab').focus();
      }
      try {
        await loadIncidents();
      } catch {
        showReportResult('보고서 이관 완료', `${summary} 목록을 새로 불러오지 못했습니다. 다시 조회해 주세요.`, result.skippedReasons);
        return;
      }
      if (result.skipped) showReportResult('일부 발생일지 이관 제외', `${summary} ${result.skipped}건은 제외했습니다.`, result.skippedReasons);
      else setMessage($('#dashboardMessage'), summary, true);
    } catch (error) {
      const message = error instanceof TypeError ? '서버 연결을 확인한 뒤 다시 시도해 주세요.' : error.message;
      showReportResult('층간소음보고서 이관 실패', message, error.skippedReasons);
    }
    finally { reportSubmitting = false; updateSelection(); }
  });

  function confirmReportRegistration(pending, fromPreview = false) {
    if (!pending.length || reportSubmitting || !reportAvailable) return;
    reportConfirmation = { recordNos: pending.map(incident => incident.recordNo), fromPreview };
    const count = pending.filter(incident => incident.counterpartConfirmed).length;
    $('#reportConfirmationSummary').textContent = `보고 대상 ${pending.length}건 중 상대세대 확인을 마친 ${count}건을 세대별 보고서에 반영합니다.`;
    reportDialog.returnValue = 'cancel';
    reportDialog.showModal();
  }

  const sortHeaders = [...committeePanel.querySelectorAll('th[data-sort]')];
  for (const header of sortHeaders) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'incident-sort'; button.textContent = header.textContent;
    header.replaceChildren(button);
    button.addEventListener('click', () => {
      const field = header.dataset.sort;
      sortDirection = sortField === field ? -sortDirection : 1;
      sortField = field;
      renderRows();
    });
  }

  function sortValue(incident) {
    if (sortField === 'reportState') return incident.reportKey ? 2 : Number(Boolean(incident.residentSelected));
    if (sortField === 'integrityStatus') return integrityInfo(incident.integrityStatus)[0];
    return incident[sortField] ?? '';
  }

  function updateReportRow(row, incident) {
    row.classList.toggle('counterpart-unconfirmed', !incident.counterpartConfirmed);
  }

  function renderRows() {
    const body = $('#incidentRows'); body.replaceChildren();
    const grouped = reportGroupView();
    const reportEntries = new Map();
    if (grouped) {
      for (const incident of incidents) {
        if (!incident.reportKey) continue;
        const entries = reportEntries.get(incident.reportKey);
        if (entries) entries.push(incident);
        else reportEntries.set(incident.reportKey, [incident]);
      }
    }
    const rows = (grouped ? [...reportEntries.values()].map(entries => entries.reduce(
      (latest, incident) => incident.startedAt > latest.startedAt ? incident : latest)) : [...incidents])
      .sort((a, b) => sortDirection * collator.compare(String(sortValue(a)), String(sortValue(b))));
    for (const header of sortHeaders) {
      if (header.dataset.sort === sortField) header.setAttribute('aria-sort', sortDirection === 1 ? 'ascending' : 'descending');
      else header.removeAttribute('aria-sort');
    }
    $('#resultCount').textContent = `총 ${rows.length}건`;
    $('#emptyState').hidden = rows.length !== 0;
    $('.table-scroll').scrollTop = 0;
    const selectable = rows.filter(canAdvance);
    const userCount = new Set(selectable.map(incident => incident.userId)).size;
    $('#selectAll').hidden = grouped;
    $('#reportGroupLabel').hidden = !grouped;
    $('#selectAll').disabled = grouped || userCount > 1 || selectable.length === 0;
    $('#selectAll').title = userCount > 1 ? '같은 신청세대의 발생일시만 선택할 수 있습니다.' : '';
    rows.forEach(incident => {
      const entries = reportEntries.get(incident.reportKey);
      const row = document.createElement('tr'); row.dataset.recordNo = incident.recordNo;
      updateReportRow(row, incident);
      const reportCell = document.createElement('td'); reportCell.className = 'check-cell'; reportCell.dataset.column = 'report-status';
      const reportStatus = document.createElement('input');
      reportStatus.type = 'checkbox'; reportStatus.className = 'row-check row-report-status';
      reportStatus.checked = Boolean(incident.residentSelected); reportStatus.disabled = true;
      reportStatus.toggleAttribute('data-included', Boolean(incident.reportKey));
      reportStatus.title = incident.reportKey ? '층간소음보고서에 포함됨' : '신청세대가 선택한 발생일지';
      reportStatus.setAttribute('aria-label', reportStatus.title);
      reportCell.append(reportStatus); row.append(reportCell);
      const deleteCell = document.createElement('td');
      deleteCell.className = 'check-cell';
      deleteCell.dataset.column = 'incident-delete';
      const deleteCheck = document.createElement('input');
      deleteCheck.type = 'checkbox';
      deleteCheck.className = 'row-check';
      deleteCheck.checked = selectedIncidentDeletes.has(incident.recordNo);
      deleteCheck.disabled = !incident.canHide;
      if (deleteCheck.disabled) deleteCheck.title = '보고서 또는 신청서에 포함된 발생일지는 숨길 수 없습니다.';
      deleteCheck.setAttribute('aria-label', `${incident.recordNo} 삭제 선택`);
      deleteCheck.addEventListener('change', () => {
        if (deleteCheck.checked) selectedIncidentDeletes.add(incident.recordNo);
        else selectedIncidentDeletes.delete(incident.recordNo);
        updateSelection();
      });
      deleteCell.append(deleteCheck); row.append(deleteCell);
      const checkCell = document.createElement('td'); checkCell.className = 'check-cell'; checkCell.dataset.column = 'reports';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'row-check report-output-check'; checkbox.value = incident.recordNo;
      if (incident.reportKey) checkbox.dataset.reportKey = incident.reportKey;
      checkbox.setAttribute('aria-label', `${incident.applicantName} ${dateTime(incident.startedAt)} 선택`);
      checkbox.disabled = !grouped && !canAdvance(incident);
      checkbox.checked = grouped ? selectedReports.has(incident.reportId) : selectedRecords.has(incident.recordNo);
      if (grouped) checkbox.disabled = !incident.reportId;
      checkbox.title = checkbox.disabled ? '음원 무결성 문제가 해결되어야 출력할 수 있습니다.' : '';
      checkbox.addEventListener('change', () => changeSelection(incident, checkbox)); checkCell.append(checkbox); row.append(checkCell);
      const numberCell = appendTextCell(row, entries?.length > 1 ? `${entries.length}건` : incident.recordNo);
      numberCell.className = 'record-number-cell';
      if (entries?.length > 1) numberCell.title = entries.map(entry => entry.recordNo).join(', ');
      appendTextCell(row, incident.reportNo, 'reports').className = 'record-number-cell';
      for (const field of ['applicantName', 'applicantPhone', 'applicantDong', 'applicantHo']) {
        appendTextCell(row, incident[field], 'applicants');
      }
      for (const field of ['otherName', 'otherDong', 'otherHo']) {
        appendTextCell(row, incident[field], 'counterparts').dataset.counterpartField = field;
      }
      for (const field of ['estimatedDong', 'estimatedHo']) {
        appendTextCell(row, incident[field]).dataset.counterpartField = field;
      }
      appendTextCell(row, dateTime(incident.startedAt)); appendTextCell(row, incident.noiseType); appendTextCell(row, incident.durationOrCount);
      const integrityCell = document.createElement('td'); integrityCell.className = 'integrity-cell';
      integrityCell.append(integrityBadge(incident.integrityStatus)); row.append(integrityCell);
      const action = document.createElement('td'); const detail = document.createElement('button');
      detail.type = 'button'; detail.className = 'detail-button'; detail.textContent = '상세보기';
      detail.setAttribute('aria-haspopup', 'dialog');
      if (grouped) {
        detail.setAttribute('aria-controls', 'incidentLogPreview');
        detail.addEventListener('click', () => openIncidentLogForm({ reportKey: incident.reportKey }));
      } else {
        detail.setAttribute('aria-controls', incidentDialog.id);
        detail.addEventListener('click', () => openIncidentDetail(row, incident));
      }
      action.append(detail); row.append(action); body.append(row);
    });
    updateSelection();
  }

  function changeSelection(incident, checkbox) {
    if (reportGroupView()) {
      if (checkbox.checked) selectedReports.set(incident.reportId, incident.reportKey);
      else selectedReports.delete(incident.reportId);
      selectedReportKey = selectedReports.size === 1 ? selectedReports.values().next().value : null;
      for (const check of document.querySelectorAll('.report-output-check')) {
        if (check.dataset.reportKey === incident.reportKey) check.checked = checkbox.checked;
      }
      updateSelection();
      return;
    }
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
    const grouped = reportGroupView();
    const count = grouped ? selectedReports.size : selectedRecords.size;
    $('#selectionCount').textContent = `${grouped ? '보고서 ' : ''}${count}건 선택`;
    $('#printSelected').disabled = grouped ? !selectedReportKey : count === 0;
    $('#downloadSelected').disabled = $('#printSelected').disabled;
    $('#deleteReports').disabled = !grouped || !count || deletingReports;
    previewReportedIncidentLog.hidden = !grouped;
    previewReportedIncidentLog.disabled = !grouped || !selectedReportKey;
    logRegister.disabled = !logRegistrationRows.length || logForms.hidden || reportSubmitting || !reportAvailable;
    deleteIncidents.disabled = !selectedIncidentDeletes.size || deletingIncidents;
    $('#incidentDocumentActions').hidden = committeePanel.dataset.view !== 'journal';
    printIncidentLog.disabled = !selectedJournalRows().length;
    writeMediationReport.disabled = printIncidentLog.disabled;
    writeVisitApplication.disabled = printIncidentLog.disabled;
    writeMeasurementApplication.disabled = printIncidentLog.disabled;
    const visibleChecks = [...document.querySelectorAll('.report-output-check:not(:disabled)')];
    $('#selectAll').checked = visibleChecks.length > 0 && visibleChecks.every(check => check.checked);
  }

  function confirmDocumentDeletion(title, summary) {
    const dialog = $('#deleteConfirmation');
    if (dialog.open) return Promise.resolve(false);
    const session = token;
    $('#deleteConfirmationTitle').textContent = title;
    $('#deleteConfirmationSummary').textContent = summary;
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete' && token === session), { once: true });
      dialog.showModal();
    });
  }

  async function deleteSelectedDocuments(endpoint, ids, message, refresh, unlock) {
    const session = token;
    try {
      const { deleted } = await request(endpoint, { method: 'DELETE', body: JSON.stringify({ ids }) });
      if (session !== token) return;
      await refresh(deleted ? `${deleted}건을 삭제했습니다.` : '이미 삭제되었거나 조회할 수 없는 항목입니다.');
    } catch (error) {
      if (session === token) {
        setMessage(message, error.message);
        message.hidden = false;
      }
    } finally {
      unlock();
    }
  }

  $('#deleteReports').addEventListener('click', async () => {
    const ids = [...selectedReports.keys()];
    if (!ids.length || deletingReports || !await confirmDocumentDeletion(`층간소음보고서 ${ids.length}건을 삭제하시겠습니까?`,
      '연결된 발생일지는 발생일지 탭에 남습니다.')) return;
    deletingReports = true;
    updateSelection();
    const message = $('#dashboardMessage');
    deleteSelectedDocuments('/api/committee/reports', ids, message, async notice => {
      await loadIncidents();
      setMessage(message, notice, true);
    }, () => {
      deletingReports = false;
      updateSelection();
    });
  });

  deleteIncidents.addEventListener('click', async () => {
    const ids = [...selectedIncidentDeletes];
    if (!ids.length || deletingIncidents || !await confirmDocumentDeletion(`발생일지 ${ids.length}건을 삭제하시겠습니까?`,
      '위원회 화면에서만 숨겨집니다. 원본 일지와 녹음의 삭제 권한은 제출한 입주민에게 있습니다.')) return;
    deletingIncidents = true;
    updateSelection();
    const message = $('#dashboardMessage');
    deleteSelectedDocuments('/api/committee/incidents', ids, message, async notice => {
      await loadIncidents();
      setMessage(message, notice, true);
    }, () => {
      deletingIncidents = false;
      updateSelection();
    });
  });

  $('#selectAll').addEventListener('change', event => {
    document.querySelectorAll('.report-output-check:not(:disabled)').forEach(check => {
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
    const checkbox = row.querySelector('.report-output-check');
    if (checkbox && !reportGroupView()) {
      checkbox.disabled = !canAdvance(incident);
      checkbox.title = checkbox.disabled ? '음원 무결성 문제가 해결되어야 출력할 수 있습니다.' : '';
      if (checkbox.disabled) { checkbox.checked = false; selectedRecords.delete(incident.recordNo); }
    }
    const selectable = incidents.filter(canAdvance);
    const userCount = new Set(selectable.map(item => item.userId)).size;
    $('#selectAll').disabled = reportGroupView() || userCount > 1 || selectable.length === 0;
    $('#selectAll').title = userCount > 1 ? '같은 신청세대의 발생일시만 선택할 수 있습니다.'
      : selectable.length === 0 ? '출력 가능한 무결성 확인 건이 없습니다.' : '';
    updateSelection();
  }

  function openIncidentDetail(row, incident) {
    clearDetail();
    const view = { controller: new AbortController(), audioUrl: null };
    detailView = view;
    $('#incidentDialogTitle').textContent = `발생일지 상세 · ${incident.recordNo}`;
    setDetailMessage('발생일지를 불러오는 중입니다.');
    incidentDialog.showModal();
    $('.incident-dialog-body').scrollTop = 0;
    loadIncidentDetail(row, incident, view, true);
  }

  async function loadIncidentDetail(row, incident, view, verify = false) {
    const { signal } = view.controller;
    const isCurrent = () => detailView === view && incidentDialog.open;
    const endpoint = `/api/committee/incidents/${incident.recordNo}`;
    try {
      if (verify) {
        const integrity = await request(`${endpoint}/integrity-check`, { method: 'POST', signal });
        if (!isCurrent()) return;
        applyIntegrity(row, incident, integrity);
      }
      const detail = await request(endpoint, { signal });
      const audioResponse = await committeeFetch(`${endpoint}/audio`, { signal });
      if (!audioResponse.ok) throw new Error('녹음 음원 파일을 불러오지 못했습니다.');
      const blob = await audioResponse.blob();
      if (!isCurrent()) return;
      const audioUrl = URL.createObjectURL(blob);
      if (view.audioUrl) URL.revokeObjectURL(view.audioUrl);
      view.audioUrl = audioUrl;
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
          const checked = await request(`${endpoint}/integrity-check`, { method: 'POST', signal });
          if (!isCurrent()) return;
          applyIntegrity(row, incident, checked);
          const message = checked.status === 'MISMATCH_BLOCKED'
            ? `원본 불일치가 확인되었습니다. 앱 알림 ${checked.notificationCreated ? '생성됨' : '기존 알림 유지'}, 이메일 ${checked.emailSent ? '발송됨' : '발송 대기'}.`
            : '음원 원본이 일치합니다.';
          setDetailMessage(message, checked.status !== 'MISMATCH_BLOCKED');
          await loadIncidentDetail(row, incident, view);
        } catch (error) { if (isCurrent()) setDetailMessage(error.message); }
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
              const saved = await request(`${endpoint}/integrity-resolution`, {
                method: 'POST', signal, body: JSON.stringify({ resolution: resolution.control.value.trim() }),
              });
              if (!isCurrent()) return;
              incident.integrityStatus = saved.status; applyIntegrity(row, incident, { status: saved.status, checkedAt: detail.integrityCheckedAt });
              setDetailMessage(`조치 내용을 기록했습니다. 일치하는 음원을 다시 제출할 때까지 출력은 차단됩니다. 주민 알림 생성, 이메일 ${saved.emailSent ? '발송 완료' : '발송 실패 기록'}.`, true);
              await loadIncidentDetail(row, incident, view);
            } catch (error) { if (isCurrent()) setDetailMessage(error.message); }
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
      if (detail.reportKey) {
        for (const field of [name, dong, ho, place]) field.control.readOnly = true;
        saveCounterpart.disabled = true;
        counterpartHelp.textContent = '층간소음보고서에 포함된 상대세대 확인 정보입니다.';
      }
      counterpartForm.addEventListener('submit', async event => {
        event.preventDefault(); saveCounterpart.disabled = true;
        try {
          const saved = await request(`${endpoint}/counterpart`, {
            method: 'PUT', body: JSON.stringify({ name: name.control.value.trim(), dong: dong.control.value.trim(),
              ho: ho.control.value.trim(), estimatedPlace: place.control.value.trim() }),
          });
          Object.assign(incident, { otherName: saved.name, otherDong: saved.dong, otherHo: saved.ho,
            estimatedDong: saved.estimatedDong, estimatedHo: saved.estimatedHo, counterpartConfirmed: saved.counterpartConfirmed });
          updateReportRow(row, incident);
          for (const cell of row.querySelectorAll('[data-counterpart-field]')) {
          const value = incident[cell.dataset.counterpartField];
          cell.textContent = value || '-';
          cell.title = value || '';
          }
          if (!isCurrent()) return;
          setDetailMessage('상대세대 확인 정보를 저장하고 변경 이력을 남겼습니다.', true);
          await loadIncidentDetail(row, incident, view);
        } catch (error) { if (isCurrent()) setDetailMessage(error.message); }
        finally { saveCounterpart.disabled = false; }
      });
      const journalDetails = document.createElement('div');
      journalDetails.className = 'incident-journal-details';
      journalDetails.append(grid, counterpartForm);
      incidentDialogContent.replaceChildren(audioBox, journalDetails);
      if (verify) setDetailMessage('');
    } catch (error) { if (isCurrent()) setDetailMessage(error.message); }
  }

  async function exportSelected(download) {
    const popup = download ? null : window.open('', '_blank');
    if (!download && !popup) {
      showReportResult('PDF 출력 실패', '팝업을 허용한 뒤 다시 시도해 주세요.');
      return;
    }
    try {
      const selection = reportGroupView() ? { reportKey: selectedReportKey } : { recordNos: [...selectedRecords] };
      const result = await requestBlob('/api/committee/export', { ...selection, download });
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
    } catch (error) {
      if (popup) popup.close();
      setMessage($('#dashboardMessage'), error.message);
    }
  }
  const logPreview = $('#incidentLogPreview');
  const logFrame = $('#incidentLogPreviewFrame');
  const logForms = $('#incidentLogForms');
  const logMessage = $('#incidentLogPreviewMessage');
  const logPrint = $('#printIncidentLogPreview');
  const logRegister = $('#registerIncidentLogPreview');
  let logPreviewRequest;
  let logPreviewUrl;
  let logRegistrationRows = [];

  function clearLogPreview() {
    logPreviewRequest?.abort();
    logPreviewRequest = undefined;
    logPreview.classList.remove('incident-log-field-preview');
    logForms.hidden = true;
    logForms.replaceChildren();
    logFrame.hidden = true;
    logFrame.removeAttribute('src');
    logPrint.disabled = true;
    logPrint.hidden = true;
    logRegistrationRows = [];
    logRegister.hidden = true;
    logRegister.disabled = true;
    if (logPreviewUrl) URL.revokeObjectURL(logPreviewUrl);
    logPreviewUrl = undefined;
  }

  function closeLogPreview() {
    logPreview.close();
    clearLogPreview();
  }

  for (const form of logPreview.querySelectorAll('form[method="dialog"]')) {
    form.addEventListener('submit', event => {
      event.preventDefault();
      closeLogPreview();
    });
  }

  logPreview.addEventListener('cancel', event => {
    event.preventDefault();
    closeLogPreview();
  });

  logFrame.addEventListener('load', () => {
    if (logPreview.open && logPreviewUrl && logFrame.getAttribute('src') === logPreviewUrl) {
      logPrint.disabled = false;
    }
  });

  async function openCommitteePdfPreview(title, endpoint, body) {
    clearLogPreview();
    logPrint.hidden = false;
    const controller = new AbortController();
    logPreviewRequest = controller;
    $('#incidentLogPreviewTitle').textContent = `${title} 미리보기`;
    logFrame.title = `${title} PDF`;
    setMessage(logMessage, 'PDF를 불러오는 중입니다.');
    logMessage.hidden = false;
    logPreview.showModal();
    try {
      const { blob } = await requestBlob(endpoint, body, controller.signal);
      if (controller.signal.aborted || !logPreview.open) return;
      logPreviewUrl = URL.createObjectURL(blob);
      logFrame.src = logPreviewUrl;
      logFrame.hidden = false;
      logMessage.hidden = true;
    } catch (error) {
      if (!controller.signal.aborted && logPreview.open) setMessage(logMessage, error.message);
    }
  }

  async function openIncidentLogForm(selection, registrationRows = []) {
    clearLogPreview();
    logPreview.classList.add('incident-log-field-preview');
    const controller = new AbortController();
    logPreviewRequest = controller;
    logRegistrationRows = registrationRows;
    logRegister.hidden = !reportAvailable || !registrationRows.length;
    $('#incidentLogPreviewTitle').textContent = '층간소음 발생일지';
    setMessage(logMessage, '발생일지를 불러오는 중입니다.');
    logMessage.hidden = false;
    logPreview.showModal();
    try {
      const { groups } = await request('/api/committee/incident-log-form', {
        method: 'POST', body: JSON.stringify(selection), signal: controller.signal,
      });
      if (controller.signal.aborted || !logPreview.open) return;
      const date = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      const template = $('#incidentLogFormTemplate');
      const entryTemplate = $('#incidentLogEntryTemplate');
      for (const group of groups) {
        const form = template.content.firstElementChild.cloneNode(true);
        for (const field of ['applicantName', 'applicantAddress']) {
          form.querySelector(`[data-field="${field}"]`).value = group[field] || '-';
        }
        const digits = (group.applicantPhone || '').replace(/[\s-]/g, '');
        form.querySelector('[data-field="applicantPhone"]').value =
          /^(02|0\d{2})\d{7,8}$/.test(digits)
            ? digits.replace(/^(02|0\d{2})(\d{3,4})(\d{4})$/, '$1-$2-$3') : group.applicantPhone || '-';
        for (const entry of group.entries) {
          const fields = entryTemplate.content.cloneNode(true);
          fields.querySelector('[data-field="startedAt"]').value = date.format(new Date(entry.startedAt)).replaceAll('-', '.');
          fields.querySelector('[data-field="noiseType"]').value = entry.noiseType || '-';
          fields.querySelector('[data-field="durationOrCount"]').value = entry.durationOrCount || '-';
          form.append(fields);
        }
        logForms.append(form);
      }
      logForms.hidden = false;
      logMessage.hidden = true;
      logRegister.disabled = !logRegistrationRows.length || reportSubmitting || !reportAvailable;
    } catch (error) {
      if (!controller.signal.aborted && logPreview.open) setMessage(logMessage, error.message);
    }
  }

  printIncidentLog.addEventListener('click', () => {
    const rows = selectedJournalRows();
    openIncidentLogForm({ recordNos: rows.map(row => row.recordNo) }, rows.filter(row => !row.reportKey));
  });

  logRegister.addEventListener('click', () => confirmReportRegistration(logRegistrationRows, true));
  previewReportedIncidentLog.addEventListener('click', () => openIncidentLogForm({ reportKey: selectedReportKey }));

  logPrint.addEventListener('click', () => {
    if (!logPreviewUrl) return;
    try {
      logFrame.contentWindow.focus();
      logFrame.contentWindow.print();
    } catch {
      logMessage.hidden = false;
      setMessage(logMessage, '미리보기 상단의 PDF 인쇄 버튼을 사용해 주세요.');
    }
  });

  const mediationDialog = $('#mediationDialog');
  const mediationForm = $('#mediationForm');
  const mediationMessage = $('#mediationFormMessage');
  const mediationConfirmation = $('#mediationConfirmation');
  const mediationSave = $('#saveMediation');
  const mediationPrint = $('#printMediation');
  const mediationEntries = $('#mediationEntries');
  let mediationDraft = null;

  function mediationStatus(element, message, success = false) {
    setMessage(element, message, success);
    element.hidden = !message;
  }

  function addMediationEntry(entry = {}) {
    const row = document.createElement('div');
    row.className = 'mediation-entry';
    if (entry.id) row.dataset.entryId = entry.id;
    const contentLabel = document.createElement('label');
    contentLabel.textContent = '중재내용';
    const content = document.createElement('textarea');
    content.rows = 3; content.maxLength = 1600; content.required = true;
    content.value = entry.content ?? '';
    contentLabel.append(content);
    const footer = document.createElement('div');
    footer.className = 'mediation-entry-footer';
    const dateLabel = document.createElement('label');
    dateLabel.textContent = '기록일';
    const date = document.createElement('input');
    date.type = 'date'; date.required = true; date.value = entry.date ?? '';
    dateLabel.append(date);
    footer.append(dateLabel);
    if (!entry.id && !entry.content) {
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'secondary compact'; remove.textContent = '항목 삭제';
      remove.addEventListener('click', () => row.remove());
      footer.append(remove);
    }
    row.append(contentLabel, footer);
    mediationEntries.append(row);
    return content;
  }

  $('#addMediationEntry').addEventListener('click', () => addMediationEntry({
    date: incidentDate.format(new Date()),
  }).focus());

  function fillMediationForm(data, entries = []) {
    const editing = Boolean(mediationDraft?.id);
    mediationForm.reset();
    for (const control of mediationForm.querySelectorAll('[name]')) {
      control.value = data[control.name] ?? '';
      control.disabled = editing && control instanceof HTMLSelectElement;
      control.readOnly = editing;
    }
    const other = data.mediatorType === '기타';
    $('#mediationOtherType').hidden = !other;
    mediationForm.elements.mediatorOther.disabled = !other;
    mediationForm.elements.mediatorOther.required = other;
    mediationEntries.replaceChildren();
    if (entries.length) entries.forEach(addMediationEntry);
    else addMediationEntry();
    mediationForm.hidden = false;
    mediationSave.hidden = false;
    mediationSave.disabled = false;
    mediationPrint.disabled = !mediationDraft?.id;
    mediationDialog.querySelector('.incident-dialog-body').scrollTop = 0;
  }

  function closeMediationDialog() {
    mediationDraft?.controller?.abort();
    mediationDraft = null;
    mediationDialog.close();
  }

  function requestMediationClose(event) {
    event.preventDefault();
    if (!mediationDraft?.saving) closeMediationDialog();
  }

  mediationDialog.querySelector('.dialog-head').addEventListener('submit', requestMediationClose);
  mediationDialog.addEventListener('cancel', requestMediationClose);
  $('#closeMediation').addEventListener('click', requestMediationClose);
  mediationForm.elements.mediatorType.addEventListener('change', event => {
    const other = event.target.value === '기타';
    $('#mediationOtherType').hidden = !other;
    mediationForm.elements.mediatorOther.disabled = !other;
    mediationForm.elements.mediatorOther.required = other;
  });

  writeMediationReport.addEventListener('click', async () => {
    const draft = {
      recordNos: selectedJournalRows().map(row => row.recordNo), requestId: crypto.randomUUID(),
      controller: new AbortController(), saving: false,
    };
    mediationDraft = draft;
    mediationForm.hidden = true;
    mediationSave.hidden = false;
    mediationSave.disabled = true;
    mediationPrint.disabled = true;
    mediationStatus(mediationMessage, '발생일지를 불러오는 중입니다.');
    mediationDialog.showModal();
    try {
      const data = await request('/api/committee/mediation-reports/prefill', {
        method: 'POST', body: JSON.stringify({ recordNos: draft.recordNos }), signal: draft.controller.signal,
      });
      if (mediationDraft !== draft) return;
      fillMediationForm({ ...data, mediatorType: '층간소음 관리위원회',
        mediatorName: currentMember?.name, mediatorPhone: currentMember?.mobile });
      mediationStatus(mediationMessage, '');
    } catch (error) {
      if (mediationDraft === draft) mediationStatus(mediationMessage, error.message);
    }
  });

  mediationForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!mediationDraft || mediationDraft.saving) return;
    const values = Object.fromEntries(new FormData(mediationForm));
    const entries = [...mediationEntries.children].map(row => ({
      id: row.dataset.entryId ? Number(row.dataset.entryId) : null,
      date: row.querySelector('input').value,
      content: row.querySelector('textarea').value.trim(),
    }));
    if (!mediationDraft.id && Object.values(values).some(value => !value.trim())) {
      mediationStatus(mediationMessage, '필수 항목을 입력해 주세요.');
      return;
    }
    if (!entries.length || entries.some(entry => !entry.date || !entry.content)) {
      mediationStatus(mediationMessage, '날짜와 내용이 있는 중재기록을 한 건 이상 입력해 주세요.');
      return;
    }
    mediationDraft.report = values;
    const originals = new Map((mediationDraft.originalEntries ?? []).map(entry => [entry.id, entry]));
    mediationDraft.entries = entries.filter(entry => {
      const original = originals.get(entry.id);
      return !entry.id || !original || entry.date !== original.date || entry.content !== original.content;
    });
    mediationConfirmation.showModal();
  });

  mediationPrint.addEventListener('click', () => {
    if (mediationDraft?.id) openCommitteePdfPreview('층간소음 중재상담 보고서',
      `/api/committee/mediation-reports/${mediationDraft.id}/pdf`, {});
  });

  mediationConfirmation.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault();
    mediationConfirmation.close();
    const draft = mediationDraft;
    if (event.submitter?.value !== 'save' || !draft || draft.saving) return;
    draft.saving = true;
    mediationSave.disabled = true;
    mediationPrint.disabled = true;
    try {
      const editing = Boolean(draft.id);
      const endpoint = '/api/committee/mediation-reports' + (editing ? `/${draft.id}` : '');
      const payload = editing
        ? { version: draft.version, entries: draft.entries }
        : { recordNos: draft.recordNos, requestId: draft.requestId, report: draft.report, entries: draft.entries };
      const result = await request(endpoint, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      if (mediationDraft !== draft) return;
      closeMediationDialog();
      const message = `중재상담 보고서 ${result.reportNo} 저장을 완료했습니다.`;
      if (editing) await loadMediationReports(message);
      else selectCommitteeTab($('#mediationTab'), message);
    } catch (error) {
      if (mediationDraft === draft) mediationStatus(mediationMessage, error.message);
    } finally {
      if (mediationDraft === draft) {
        draft.saving = false;
        mediationSave.disabled = false;
        mediationPrint.disabled = !draft.id;
      }
    }
  });

  let mediationListRequest = 0;
  const mediationFilters = $('#mediationFilters');
  const mediationRows = $('#mediationRows');
  const deleteMediation = $('#deleteMediation');
  const selectedMediationReports = new Set();
  let deletingMediation = false;
  const mediationSortHeaders = [...$('#mediationPanel').querySelectorAll('th[data-sort]')];
  let mediationSortColumn = mediationSortHeaders[0];
  let mediationSortDirection = -1;

  function sortMediationRows() {
    const index = mediationSortColumn.cellIndex;
    const value = row => row.cells[index].dataset.sortValue ?? row.cells[index].textContent;
    const ordered = [...mediationRows.rows]
      .sort((a, b) => mediationSortDirection * collator.compare(value(a), value(b)));
    for (const header of mediationSortHeaders) {
      if (header === mediationSortColumn) header.setAttribute('aria-sort', mediationSortDirection === 1 ? 'ascending' : 'descending');
      else header.removeAttribute('aria-sort');
    }
    mediationRows.append(...ordered);
  }

  for (const header of mediationSortHeaders) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'incident-sort'; button.textContent = header.textContent;
    header.replaceChildren(button);
    button.addEventListener('click', () => {
      mediationSortDirection = header === mediationSortColumn ? -mediationSortDirection : 1;
      mediationSortColumn = header;
      sortMediationRows();
    });
  }

  async function loadMediationReports(success = '') {
    const loadId = ++mediationListRequest;
    const message = $('#mediationListMessage');
    selectedMediationReports.clear();
    deleteMediation.disabled = true;
    mediationRows.replaceChildren();
    $('#mediationResultCount').textContent = '';
    mediationStatus(message, '저장된 보고서를 불러오는 중입니다.');
    try {
      const { reports } = await request(`/api/committee/mediation-reports?${filtersQuery(mediationFilters)}`);
      if (loadId !== mediationListRequest || !token) return;
      for (const report of reports) {
        const row = document.createElement('tr');
        const selectCell = row.insertCell();
        selectCell.className = 'check-cell';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'row-check';
        checkbox.setAttribute('aria-label', `${report.reportNo} 선택`);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedMediationReports.add(report.id);
          else selectedMediationReports.delete(report.id);
          deleteMediation.disabled = deletingMediation || !selectedMediationReports.size;
        });
        selectCell.append(checkbox);
        const data = report.data;
        for (const value of [report.reportNo, data.mediatorName,
          [data.applicantName, data.applicantUnit].filter(Boolean).join(' '),
          [data.counterpartName, data.counterpartUnit].filter(Boolean).join(' '), data.noiseType]) {
          appendTextCell(row, value);
        }
        appendTextCell(row, dateTime(report.createdAt)).dataset.sortValue = report.createdAt;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'detail-button'; button.textContent = '상세·수정';
        button.setAttribute('aria-haspopup', 'dialog');
        button.addEventListener('click', () => {
          mediationDraft = { id: report.id, version: report.version, originalEntries: report.entries, saving: false };
          mediationStatus(mediationMessage, '');
          fillMediationForm(data, report.entries);
          mediationDialog.showModal();
        });
        const action = document.createElement('td');
        action.append(button); row.append(action); mediationRows.append(row);
      }
      sortMediationRows();
      $('#mediationResultCount').textContent = `총 ${reports.length}건`;
      mediationStatus(message, success || (reports.length ? '' : '조회된 중재상담 보고서가 없습니다.'), Boolean(success));
    } catch (error) {
      if (loadId === mediationListRequest) mediationStatus(message, error.message);
    }
  }
  deleteMediation.addEventListener('click', async () => {
    const ids = [...selectedMediationReports];
    if (!ids.length || deletingMediation || !await confirmDocumentDeletion(`중재상담 보고서 ${ids.length}건을 삭제하시겠습니까?`,
      '선택한 보고서에 저장된 중재 이력도 함께 삭제됩니다.')) return;
    deletingMediation = true;
    deleteMediation.disabled = true;
    deleteSelectedDocuments('/api/committee/mediation-reports', ids, $('#mediationListMessage'), loadMediationReports, () => {
      deletingMediation = false;
      deleteMediation.disabled = !selectedMediationReports.size;
    });
  });

  mediationFilters.addEventListener('submit', event => {
    event.preventDefault();
    loadMediationReports();
  });
  $('#resetMediationFilters').addEventListener('click', () => {
    mediationFilters.reset();
    loadMediationReports();
  });

  function setupIncidentApplication({ key, endpoint, title, button, getColumns, canEdit, pdfTitle, confirmation }) {
    const cap = key[0].toUpperCase() + key.slice(1);
    const dialog = $('#' + key + 'Dialog');
    const form = $('#' + key + 'Form');
    const save = $('#save' + cap);
    const formMessage = $('#' + key + 'FormMessage');
    const filters = $('#' + key + 'Filters');
    const body = $('#' + key + 'Rows');
    const deleteButton = $('#delete' + cap);
    const selected = new Set();
    let deleting = false;
    let draft = null;
    let latestLoad = 0;

    function close() {
      draft?.controller.abort();
      draft = null;
      if (confirmation?.open) confirmation.close('cancel');
      dialog.close();
    }

    function requestClose(event) {
      event.preventDefault();
      if (!draft?.saving) close();
    }

    dialog.querySelector('.dialog-head').addEventListener('submit', requestClose);
    dialog.addEventListener('cancel', requestClose);
    $('#close' + cap).addEventListener('click', requestClose);

    function fillForm(data, editable) {
      form.reset();
      for (const control of form.querySelectorAll('[name]')) {
        control.value = data[control.name] ?? '';
        control.readOnly = !editable || !canEdit(control.name);
        if (control.readOnly) control.placeholder = '확인되지 않음';
      }
      form.hidden = false;
      save.hidden = !editable;
      save.disabled = !editable;
      dialog.querySelector('.incident-dialog-body').scrollTop = 0;
    }

    function showError(error) {
      if (error.code === 'CHAIR_REQUIRED') {
        close();
        showReportResult(title + ' 안내', error.message);
      } else mediationStatus(formMessage, error.message);
    }

    button.addEventListener('click', async () => {
      const current = { recordNos: selectedJournalRows().map(row => row.recordNo), requestId: crypto.randomUUID(),
        controller: new AbortController(), saving: false };
      draft = current;
      form.hidden = true;
      save.hidden = false;
      save.disabled = true;
      mediationStatus(formMessage, '발생일지를 불러오는 중입니다.');
      dialog.showModal();
      try {
        const data = await request(endpoint + '/prefill', {
          method: 'POST', body: JSON.stringify({ recordNos: current.recordNos }), signal: current.controller.signal,
        });
        if (draft !== current) return;
        fillForm({ ...data, applicationDate: incidentDate.format(new Date()) }, true);
        mediationStatus(formMessage, '');
      } catch (error) {
        if (draft === current) showError(error);
      }
    });

    form.addEventListener('submit', event => {
      event.preventDefault();
      const current = draft;
      if (!current || current.saving) return;
      const application = Object.fromEntries([...new FormData(form)].filter(([name]) => canEdit(name)));
      if (Object.values(application).some(value => !value.trim())) {
        mediationStatus(formMessage, '신청서의 필수 항목을 확인해 주세요.');
        return;
      }
      if (confirmation) {
        current.pendingApplication = application;
        confirmation.showModal();
      } else saveApplication(current, application);
    });

    confirmation?.querySelector('form').addEventListener('submit', event => {
      if (event.submitter?.value !== 'submit' || !draft?.pendingApplication) return;
      event.preventDefault();
      const current = draft;
      const application = current.pendingApplication;
      current.pendingApplication = null;
      confirmation.close('submit');
      saveApplication(current, application);
    });

    async function saveApplication(current, application) {
      current.saving = true;
      save.disabled = true;
      try {
        const result = await request(endpoint, {
          method: 'POST', body: JSON.stringify({ recordNos: current.recordNos, requestId: current.requestId, application }),
        });
        if (draft !== current) return;
        close();
        selectCommitteeTab($('#' + key + 'Tab'), title + '서 ' + result.id + '번을 저장했습니다.');
      } catch (error) {
        if (draft === current) showError(error);
      } finally {
        if (draft === current) { current.saving = false; save.disabled = false; }
      }
    }

    async function load(success = '') {
      const loadId = ++latestLoad;
      const message = $('#' + key + 'ListMessage');
      const count = $('#' + key + 'ResultCount');
      selected.clear();
      deleteButton.disabled = true;
      body.replaceChildren();
      count.textContent = '';
      mediationStatus(message, '저장된 신청서를 불러오는 중입니다.');
      try {
        const { applications } = await request(endpoint + '?' + filtersQuery(filters));
        if (loadId !== latestLoad || !token) return;
        for (const application of applications) {
          const row = document.createElement('tr');
          const check = document.createElement('input');
          check.type = 'checkbox';
          check.className = 'row-check';
          check.setAttribute('aria-label', `${application.serialNo} 선택`);
          check.addEventListener('change', () => {
            if (check.checked) selected.add(application.id);
            else selected.delete(application.id);
            deleteButton.disabled = deleting || !selected.size;
          });
          row.insertCell().className = 'check-cell';
          row.cells[0].append(check);
          appendTextCell(row, application.serialNo).className = 'record-number-cell';
          for (const value of getColumns(application)) appendTextCell(row, value);
          const details = document.createElement('button');
          details.type = 'button'; details.className = 'detail-button'; details.textContent = '상세보기';
          details.setAttribute('aria-haspopup', 'dialog');
          details.addEventListener('click', () => {
            fillForm(application.data, false);
            mediationStatus(formMessage, '');
            dialog.showModal();
          });
          row.insertCell().append(details);
          if (pdfTitle) {
            const print = document.createElement('button');
            print.type = 'button'; print.className = 'detail-button'; print.textContent = '출력';
            print.setAttribute('aria-haspopup', 'dialog');
            print.setAttribute('aria-controls', 'incidentLogPreview');
            print.addEventListener('click', () => openCommitteePdfPreview(pdfTitle, endpoint + '/' + application.id + '/pdf', {}));
            row.insertCell().append(print);
          }
          body.append(row);
        }
        count.textContent = '총 ' + applications.length + '건';
        mediationStatus(message, success || (applications.length ? '' : '조회된 ' + title + '서가 없습니다.'), Boolean(success));
      } catch (error) {
        if (loadId === latestLoad) mediationStatus(message, error.message);
      }
    }

    deleteButton.addEventListener('click', async () => {
      const ids = [...selected];
      if (!ids.length || deleting || !await confirmDocumentDeletion(`${title}서 ${ids.length}건을 삭제하시겠습니까?`,
        '삭제한 신청서는 복구할 수 없습니다.')) return;
      deleting = true;
      deleteButton.disabled = true;
      deleteSelectedDocuments(endpoint, ids, $('#' + key + 'ListMessage'), load, () => {
        deleting = false;
        deleteButton.disabled = !selected.size;
      });
    });

    filters.addEventListener('submit', event => { event.preventDefault(); load(); });
    $('#reset' + cap + 'Filters').addEventListener('click', () => { filters.reset(); load(); });
    return { close, load };
  }

  const visitApplications = setupIncidentApplication({
    key: 'visit', endpoint: '/api/committee/visit-applications', title: '방문상담 신청', button: writeVisitApplication,
    canEdit: name => name === 'applicationDate', pdfTitle: '층간소음 방문상담 신청서',
    getColumns: ({ data }) => [data.applicationDate, data.complexName, data.managerName,
      data.applicantName, data.counterpartName, data.noiseType],
  });
  const measurementApplications = setupIncidentApplication({
    key: 'measurement', endpoint: '/api/committee/measurement-applications', title: '층간소음 측정 신청', button: writeMeasurementApplication,
    confirmation: $('#measurementConfirmation'),
    canEdit: name => ['visitDate', 'postVisitNoise', 'applicationDate'].includes(name),
    getColumns: ({ data }) => [data.applicationDate, data.visitDate, data.complexName,
      data.applicantName, data.counterpartName, data.noiseType],
  });

  const memberSettings = $('#memberSettings');
  const memberSettingsForm = $('#memberSettingsForm');
  const memberSettingsMessage = $('#memberSettingsMessage');
  const memberPasswordDialog = $('#memberPasswordDialog');
  const memberPassword = $('#memberCurrentPassword');
  const memberPasswordMessage = $('#memberPasswordMessage');
  const editableMemberFields = ['name', 'mobile', 'contact', 'addressDetail'];
  let settingsRecord = null;
  let settingsUpdate = null;
  let settingsLoad = 0;
  let settingsSaving = false;

  function closeMemberSettings(restoreFocus = true) {
    settingsLoad++;
    settingsRecord = null;
    settingsUpdate = null;
    if (memberPasswordDialog.open) memberPasswordDialog.close();
    memberPassword.value = '';
    memberSettingsForm.reset();
    settingsSignature.reset();
    memberSettings.hidden = true;
    $('#committeeWorkspace').hidden = false;
    if (restoreFocus) $('#openMemberSettings').focus();
  }

  async function loadMemberSettings(success = '') {
    const loadId = ++settingsLoad;
    memberSettingsForm.hidden = true;
    mediationStatus(memberSettingsMessage, '위원 정보를 불러오는 중입니다.');
    try {
      const data = await request('/api/committee/member-settings');
      if (loadId !== settingsLoad || memberSettings.hidden) return;
      settingsRecord = data;
      for (const control of memberSettingsForm.querySelectorAll('[name]')) control.value = data[control.name] ?? '';
      settingsSignature.reset(data.signature ?? null);
      memberSettingsForm.hidden = false;
      mediationStatus(memberSettingsMessage, success, Boolean(success));
    } catch (error) {
      if (loadId === settingsLoad) mediationStatus(memberSettingsMessage,
        success ? `${success} 화면을 다시 불러오지 못했습니다. 설정을 다시 열어 주세요.` : error.message, Boolean(success));
    }
  }

  $('#openMemberSettings').addEventListener('click', () => {
    if (!memberSettings.hidden) return;
    $('#committeeWorkspace').hidden = true;
    memberSettings.hidden = false;
    $('#memberSettingsTitle').focus();
    loadMemberSettings();
  });
  $('#closeMemberSettings').addEventListener('click', () => closeMemberSettings());

  memberSettingsForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!settingsRecord || settingsSaving) return;
    const changes = Object.fromEntries(editableMemberFields.map(key => [key, memberSettingsForm.elements[key].value.trim()]));
    let signature;
    try { signature = settingsSignature.value(); }
    catch (error) { mediationStatus(memberSettingsMessage, error.message); return; }
    const comparable = (key, value) => key === 'mobile' || key === 'contact' ? value.replace(/[\s-]/g, '') : value;
    if (signature === undefined && editableMemberFields.every(key => comparable(key, changes[key]) === comparable(key, settingsRecord[key] ?? ''))) {
      mediationStatus(memberSettingsMessage, '변경된 정보가 없습니다.');
      return;
    }
    settingsUpdate = { ...changes, version: settingsRecord.version, signature };
    memberPassword.value = '';
    mediationStatus(memberPasswordMessage, '');
    memberPasswordDialog.showModal();
  });

  $('#cancelMemberPassword').addEventListener('click', () => {
    if (!settingsSaving) memberPasswordDialog.close();
  });
  memberPasswordDialog.addEventListener('cancel', event => { if (settingsSaving) event.preventDefault(); });
  memberPasswordDialog.addEventListener('close', () => { if (!memberPasswordDialog.open) memberPassword.value = ''; });
  $('#memberPasswordForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!settingsUpdate || settingsSaving) return;
    settingsSaving = true;
    $('#confirmMemberPassword').disabled = true;
    $('#cancelMemberPassword').disabled = true;
    const updates = settingsUpdate;
    const password = memberPassword.value;
    memberPassword.value = '';
    try {
      const data = await request('/api/committee/member-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/vnd.mutelab.committee+json' },
        body: JSON.stringify({ ...updates, password }),
      });
      if (updates !== settingsUpdate || !token) return;
      memberPasswordDialog.close();
      settingsUpdate = null;
      await loadMemberSettings(data.message);
      request('/api/committee/me').then(me => { if (token) showMemberSummary(me); }).catch(() => {});
    } catch (error) {
      if (updates === settingsUpdate && memberPasswordDialog.open) {
        mediationStatus(memberPasswordMessage, error.message);
        memberPassword.focus();
      }
    } finally {
      settingsSaving = false;
      $('#confirmMemberPassword').disabled = false;
      $('#cancelMemberPassword').disabled = false;
    }
  });

  $('#printSelected').addEventListener('click', () => exportSelected(false));
  $('#downloadSelected').addEventListener('click', () => exportSelected(true));

  if (token) openDashboard();
  else if (new URLSearchParams(location.search).get('signup') === '1') $('#openSignup').click();
})();
