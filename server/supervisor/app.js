(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const state = {
    token: '',
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
    query: '',
    status: 'ALL',
    currentKaptCode: '',
    detail: null,
    reviewedDocuments: new Map(),
    listBusy: false,
    decisionBusy: false,
  };

  const statusLabels = {
    UNREGISTERED: '미가입', NOT_JOINED: '미가입', NONE: '미가입',
    PENDING: '승인 대기', APPROVED: '가입 승인', JOINED: '가입 승인',
    FULL: '정원 완료', REJECTED: '반려',
  };

  function pick(value, ...keys) {
    if (!value || typeof value !== 'object') return undefined;
    for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
    return undefined;
  }

  function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function parseObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function setMessage(target, message, success = false) {
    target.textContent = message || '';
    target.classList.toggle('success', Boolean(success));
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  function normalizeStatus(row) {
    const explicit = String(pick(row, 'status', 'committeeStatus', 'Status', 'CommitteeStatus') || '').toUpperCase();
    if (['UNREGISTERED', 'NOT_REGISTERED', 'NOT_JOINED', 'NONE'].includes(explicit)) return 'UNREGISTERED';
    if (['APPROVED', 'JOINED'].includes(explicit)) return 'APPROVED';
    if (explicit) return explicit;
    const pending = asNumber(pick(row, 'pendingCount', 'pendingApplicationCount', 'PendingCount', 'PendingApplicationCount'));
    const approved = asNumber(pick(row, 'approvedMemberCount', 'approvedCount', 'memberCount',
      'ApprovedMemberCount', 'ApprovedCount', 'MemberCount'));
    const rejected = asNumber(pick(row, 'rejectedCount', 'rejectedApplicationCount', 'RejectedCount', 'RejectedApplicationCount'));
    if (pending > 0) return 'PENDING';
    if (approved >= 3) return 'FULL';
    if (approved > 0) return 'APPROVED';
    if (rejected > 0) return 'REJECTED';
    return 'UNREGISTERED';
  }

  function statusBadge(status) {
    const normalized = String(status || 'UNKNOWN').toUpperCase();
    const badge = element('span', `status-badge status-${normalized.toLowerCase()}`,
      statusLabels[normalized] || normalized || '확인 필요');
    return badge;
  }

  const loginForm = $('#supervisorLogin');
  const enrollmentForm = $('#supervisorEnrollment');
  const otpInput = loginForm.elements.code;
  const authMessage = $('#authMessage');
  const otpQrCode = $('#otpQrCode');
  const otpManualSetup = $('#otpManualSetup');
  const documentDialog = $('#documentDialog');
  const documentImage = $('#documentImage');
  const documentPdf = $('#documentPdf');
  const documentPdfDownload = $('#documentPdfDownload');
  const documentMessage = $('#documentMessage');
  const businessRegistrationForm = $('#businessRegistrationForm');
  const businessRegistrationInput = $('#businessRegistrationInput');
  const saveBusinessRegistration = $('#saveBusinessRegistration');
  const businessRegistrationDigits = value => value.replace(/\D/g, '').slice(0, 10);
  businessRegistrationInput.addEventListener('focus', () => {
    businessRegistrationInput.value = businessRegistrationDigits(businessRegistrationInput.value);
  });
  businessRegistrationInput.addEventListener('input', () => {
    const { value, selectionStart } = businessRegistrationInput;
    const digits = businessRegistrationDigits(value);
    if (digits === value) return;
    const caret = businessRegistrationDigits(value.slice(0, selectionStart)).length;
    businessRegistrationInput.value = digits;
    businessRegistrationInput.setSelectionRange(caret, caret);
  });
  businessRegistrationInput.addEventListener('blur', () => {
    businessRegistrationInput.value = formatBusinessRegistration(businessRegistrationInput.value);
  });
  const decisionConfirmation = $('#decisionConfirmation');
  const detailTabs = $('#detailSeatTabs');
  const detailTabButtons = [...detailTabs.querySelectorAll('[role="tab"]')];
  let documentPreview = null;
  let activeDetailSlot = null;
  let enrollmentToken = '';

  function clearOtpSetup() {
    otpQrCode.removeAttribute('src');
    otpQrCode.hidden = true;
    otpManualSetup.open = false;
    $('#otpSetupKey').value = '';
  }

  function showLogin(message = '') {
    const email = loginForm.elements.email.value;
    state.token = '';
    enrollmentToken = '';
    loginForm.reset();
    loginForm.elements.email.value = email;
    enrollmentForm.reset();
    clearOtpSetup();
    $('#loginOtp').hidden = true;
    otpInput.disabled = true;
    otpInput.required = false;
    enrollmentForm.hidden = true;
    loginForm.hidden = false;
    $('#supervisorAuth').hidden = false;
    $('#supervisorWorkspace').hidden = true;
    $('#sessionActions').hidden = true;
    $('#complexRows').replaceChildren();
    $('#supervisorInquiryList').replaceChildren();
    $('#complexPagination').hidden = true;
    supervisorNotifications.close();
    setNotificationCount(0);
    decisionConfirmation.close('cancel');
    documentDialog.close();
    $('#detailDialog').close();
    setMessage(authMessage, message);
    loginForm.elements[email ? 'password' : 'email'].focus();
  }

  async function authenticate(path, data) {
    const response = await fetch(path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || '인증 요청을 처리하지 못했습니다.'),
      { code: result.code, status: response.status });
    return result;
  }

  function finishLogin(result) {
    if (!result.sessionToken) throw new Error('로그인 세션을 시작하지 못했습니다.');
    state.token = result.sessionToken;
    enrollmentToken = '';
    enrollmentForm.reset();
    clearOtpSetup();
    loginForm.elements.password.value = '';
    otpInput.value = '';
    $('#supervisorAuth').hidden = true;
    $('#supervisorWorkspace').hidden = false;
    $('#sessionActions').hidden = false;
    state.page = 1;
    selectSupervisorTab($('#complexTab'), true);
    void refreshNotificationCount();
  }

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    if (button.disabled) return;
    button.disabled = true;
    setMessage(authMessage, '');
    try {
      const result = await authenticate('/api/supervisor/login', Object.fromEntries(new FormData(loginForm)));
      if (result.enrollmentToken) {
        enrollmentToken = result.enrollmentToken;
        loginForm.elements.password.value = '';
        loginForm.hidden = true;
        enrollmentForm.hidden = false;
        $('#otpSetupKey').value = result.setupKey;
        if (typeof result.qrCode === 'string' && result.qrCode.startsWith('data:image/png;base64,')) {
          otpQrCode.src = result.qrCode;
          otpQrCode.hidden = false;
        } else {
          otpManualSetup.open = true;
        }
        enrollmentForm.elements.code.focus();
      } else finishLogin(result);
    } catch (error) {
      if (error.code === 'OTP_REQUIRED') {
        $('#loginOtp').hidden = false;
        otpInput.disabled = false;
        otpInput.required = true;
        otpInput.focus();
        otpInput.select();
      }
      setMessage(authMessage, error.message);
    } finally { button.disabled = false; }
  });

  enrollmentForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    if (button.disabled || !enrollmentToken) return;
    button.disabled = true;
    const cancel = $('#cancelEnrollment');
    cancel.disabled = true;
    setMessage(authMessage, '');
    try {
      finishLogin(await authenticate('/api/supervisor/enroll',
        { ...Object.fromEntries(new FormData(enrollmentForm)), enrollmentToken }));
    } catch (error) {
      if (error.status === 401 || error.status === 409) showLogin(error.message);
      else setMessage(authMessage, error.message);
    } finally { button.disabled = false; cancel.disabled = false; }
  });

  $('#cancelEnrollment').addEventListener('click', () => showLogin());
  $('#logoutButton').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    try { await api('/api/supervisor/logout', { method: 'POST' }); }
    catch (error) {
      if (state.token) { setMessage($('#pageMessage'), error.message); return; }
    } finally { button.disabled = false; }
    showLogin();
  });

  async function api(path, options = {}) {
    const session = state.token;
    if (!session) throw new Error('로그인해 주세요.');
    const headers = new Headers(options.headers || {});
    headers.set('X-Supervisor-Token', session);
    headers.set('Accept', 'application/json');
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      if (session === state.token) showLogin('로그인 시간이 만료되었습니다. 다시 로그인해 주세요.');
      throw new Error('다시 로그인해 주세요.');
    }
    if (options.raw) {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || '요청을 처리하지 못했습니다.');
      }
      return response;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '요청을 처리하지 못했습니다.');
    return payload;
  }

  function renderSummary(summary, items) {
    const total = asNumber(pick(summary, 'total', 'totalComplexes', 'Total', 'TotalComplexes'), state.total);
    const registered = asNumber(pick(summary, 'registered', 'registeredComplexes', 'withCommittee', 'joined',
      'Registered', 'RegisteredComplexes', 'WithCommittee', 'Joined'),
      items.filter(item => normalizeStatus(item) !== 'UNREGISTERED').length);
    const pending = asNumber(pick(summary, 'pending', 'pendingComplexes', 'Pending', 'PendingComplexes'),
      items.filter(item => normalizeStatus(item) === 'PENDING').length);
    const unregistered = asNumber(pick(summary, 'unregistered', 'unregisteredComplexes', 'withoutCommittee', 'notJoined',
      'Unregistered', 'UnregisteredComplexes', 'WithoutCommittee', 'NotJoined'),
      Math.max(0, total - registered));
    $('#summaryRegistered').textContent = registered.toLocaleString('ko-KR');
    $('#summaryPending').textContent = pending.toLocaleString('ko-KR');
    $('#summaryUnregistered').textContent = unregistered.toLocaleString('ko-KR');
  }

  function renderComplexRows(items) {
    const body = $('#complexRows');
    body.replaceChildren();
    items.forEach(item => {
      const kaptCode = String(pick(item, 'kaptCode', 'KaptCode') || '');
      const kaptName = String(pick(item, 'kaptName', 'KaptName') || '이름 없는 단지');
      const address = String(pick(item, 'address', 'baseAddress', 'Address', 'BaseAddress') || '-');
      const pending = asNumber(pick(item, 'pendingCount', 'pendingApplicationCount', 'PendingCount', 'PendingApplicationCount'));
      const members = asNumber(pick(item, 'approvedMemberCount', 'approvedCount', 'memberCount',
        'ApprovedMemberCount', 'ApprovedCount', 'MemberCount'));
      const firstSubmitted = pick(item, 'firstSubmittedAt', 'lastSubmittedAt', 'latestSubmittedAt',
        'FirstSubmittedAt', 'LastSubmittedAt', 'LatestSubmittedAt');
      const row = document.createElement('tr');
      const statusCell = document.createElement('td');
      statusCell.append(statusBadge(normalizeStatus(item)));
      const nameCell = document.createElement('td');
      nameCell.append(element('strong', 'complex-name', kaptName), element('span', 'complex-code', kaptCode || '-'));
      const addressCell = element('td', 'address-cell', address);
      addressCell.title = address;
      const pendingCell = element('td', 'number-cell', `${pending}명`);
      const memberCell = element('td', 'number-cell', `${members}명`);
      const dateCell = element('td', 'date-cell', formatDate(firstSubmitted));
      const certificate = element('td', 'business-document-cell');
      certificate.append(element('span', '', formatBusinessRegistration(item.businessRegistrationNumber) || '-'));
      const documentId = asNumber(item.documentApplicationId);
      const viewCertificate = element('button', 'button secondary compact', '보기');
      viewCertificate.type = 'button';
      viewCertificate.disabled = !documentId;
      viewCertificate.setAttribute('aria-label', `${kaptName} 사업자등록증 보기`);
      viewCertificate.setAttribute('aria-haspopup', 'dialog');
      viewCertificate.setAttribute('aria-controls', 'documentDialog');
      if (documentId) viewCertificate.addEventListener('click', () => reviewDocument(documentId, false));
      certificate.append(viewCertificate);
      const actionCell = document.createElement('td');
      const button = element('button', 'button secondary compact', '상세보기');
      button.type = 'button';
      button.setAttribute('aria-label', `${kaptName} 위원회 상세보기`);
      button.disabled = !kaptCode;
      button.addEventListener('click', () => openDetail(kaptCode));
      actionCell.append(button);
      row.append(statusCell, nameCell, addressCell, pendingCell, memberCell, dateCell, certificate, actionCell);
      body.append(row);
    });
    $('#emptyState').hidden = items.length > 0;
  }

  function formatBusinessRegistration(value) {
    const text = typeof value === 'string' ? value : '';
    return text.replace(/^(\d{3})(\d{2})(\d{5})$/, '$1-$2-$3');
  }

  function pageNumbers(current, total) {
    if (total <= 9) return Array.from({ length: total }, (_, index) => index + 1);
    const visible = new Set([1, 2, total - 1, total]);
    for (let page = Math.max(1, current - 2); page <= Math.min(total, current + 2); page += 1) visible.add(page);
    const numbers = [];
    let previous = 0;
    for (const page of [...visible].sort((a, b) => a - b)) {
      if (page - previous > 2) numbers.push(null);
      else if (page - previous === 2) numbers.push(previous + 1);
      numbers.push(page);
      previous = page;
    }
    return numbers;
  }

  function renderPagination() {
    const nav = $('#complexPagination');
    const restoreFocus = nav.contains(document.activeElement);
    nav.replaceChildren();
    nav.hidden = !state.total;
    if (nav.hidden) return;
    for (const page of pageNumbers(state.page, state.totalPages)) {
      if (page === null) {
        const gap = element('span', 'pagination-gap', '…');
        gap.setAttribute('aria-hidden', 'true');
        nav.append(gap);
        continue;
      }
      const current = page === state.page;
      const button = element('button', 'button secondary compact', page);
      button.type = 'button';
      button.setAttribute('aria-label', `${page}페이지`);
      if (current) button.setAttribute('aria-current', 'page');
      else button.addEventListener('click', () => loadComplexes(page));
      nav.append(button);
      if (current && restoreFocus) button.focus();
    }
  }

  async function loadComplexes(page = state.page) {
    if (state.listBusy) return;
    state.listBusy = true;
    $('#refreshButton').disabled = true;
    setMessage($('#pageMessage'), '단지 정보를 불러오는 중입니다.');
    try {
      const params = new URLSearchParams({
        query: state.query, status: state.status, page: String(page), pageSize: String(state.pageSize),
      });
      const payload = await api(`/api/supervisor/complexes?${params}`);
      const items = pick(payload, 'items', 'complexes', 'rows') || [];
      const safeItems = Array.isArray(items) ? items : [];
      state.total = asNumber(pick(payload, 'total', 'totalCount', 'Total', 'TotalCount'), safeItems.length);
      state.page = Math.max(1, asNumber(pick(payload, 'page', 'Page'), page));
      state.pageSize = Math.max(1, asNumber(pick(payload, 'pageSize', 'size', 'PageSize', 'Size'), state.pageSize));
      state.totalPages = Math.max(1, asNumber(pick(payload, 'totalPages', 'TotalPages'), Math.ceil(state.total / state.pageSize)));
      renderSummary(pick(payload, 'summary', 'counts', 'Summary', 'Counts') || {}, safeItems);
      renderComplexRows(safeItems);
      renderPagination();
      setMessage($('#pageMessage'), '');
    } catch (error) {
      renderComplexRows([]);
      $('#complexPagination').hidden = true;
      setMessage($('#pageMessage'), error.message);
    } finally {
      state.listBusy = false;
      $('#refreshButton').disabled = false;
    }
  }

  function combinedPerson(row) {
    const embedded = parseObject(pick(row, 'member', 'memberJson', 'Member', 'MemberJson'));
    return { ...embedded, ...row };
  }

  function personField(label, value, wide = false) {
    const field = element('div', `person-field${wide ? ' wide' : ''}`);
    field.append(element('span', '', label), element('strong', '', value || '-'));
    return field;
  }

  function appendDocumentAction(card, applicationId, pending) {
    if (!applicationId) return;
    const row = element('div', 'document-row');
    const reviewed = pending && state.reviewedDocuments.has(applicationId);
    if (pending) {
      row.append(element('span', `document-state${reviewed ? ' reviewed' : ''}`, reviewed ? '서류 확인 완료' : '서류 확인 필요'));
    }
    const button = element('button', 'button secondary compact', reviewed ? '사업자등록증 다시 보기' : '사업자등록증 보기');
    button.dataset.documentApplication = String(applicationId);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'documentDialog');
    button.type = 'button';
    button.addEventListener('click', () => reviewDocument(applicationId, pending));
    row.append(button);
    card.append(row);
  }

  function renderMembers(members) {
    const list = $('#memberList');
    list.replaceChildren();
    members.forEach(row => {
      const person = combinedPerson(row);
      const card = element('article', 'person-card');
      const head = element('div', 'person-card-head');
      const title = document.createElement('div');
      title.append(element('strong', '', String(pick(person, 'name', 'Name') || '이름 미등록')),
        element('p', '', `좌석 ${pick(person, 'seat', 'Seat') || '-'}`));
      head.append(title, statusBadge('APPROVED'));
      const grid = element('div', 'person-grid');
      grid.append(
        personField('직위', pick(person, 'role', 'Role')),
        personField('이메일', pick(person, 'email', 'Email')),
        personField('모바일폰', pick(person, 'mobile', 'Mobile')),
        personField('연락처', pick(person, 'contact', 'Contact')),
        personField('주소', pick(person, 'address', 'Address'), true),
        personField('승인일시', formatDate(pick(person, 'approvedAt', 'ApprovedAt'))),
      );
      card.append(head, grid);
      const memberId = asNumber(pick(person, 'memberId', 'MemberId'));
      const application = memberId && state.detail.applications.find(item =>
        asNumber(pick(item, 'approvedMemberId', 'ApprovedMemberId')) === memberId
        && String(pick(item, 'status', 'Status') || '').toUpperCase() === 'APPROVED');
      if (application) appendDocumentAction(card, asNumber(pick(application, 'applicationId', 'ApplicationId')), false);
      list.append(card);
    });
  }

  function pendingApplications() {
    const applications = Array.isArray(state.detail?.applications) ? state.detail.applications : [];
    return applications.filter(row => String(pick(row, 'status', 'Status') || '').toUpperCase() === 'PENDING');
  }

  function renderApplications(applications) {
    const list = $('#applicationList');
    list.replaceChildren();
    applications.forEach(row => {
      const person = combinedPerson(row);
      const applicationId = asNumber(pick(person, 'applicationId', 'ApplicationId'));
      const status = String(pick(person, 'status', 'Status') || 'PENDING').toUpperCase();
      const card = element('article', 'application-card');
      const head = element('div', 'application-card-head');
      const title = document.createElement('div');
      title.append(element('strong', '', String(pick(person, 'name', 'Name') || '이름 미등록')),
        element('p', '', `신청번호 ${applicationId || '-'}`));
      head.append(title, statusBadge(status));
      const grid = element('div', 'person-grid');
      grid.append(
        personField('직위', pick(person, 'requestedRole', 'RequestedRole', 'role', 'Role')),
        personField('이메일', pick(person, 'email', 'Email')),
        personField('모바일폰', pick(person, 'mobile', 'Mobile')),
        personField('연락처', pick(person, 'contact', 'Contact')),
        personField('주소', pick(person, 'address', 'Address'), true),
        personField('신청일시', formatDate(pick(person, 'submittedAt', 'SubmittedAt'))),
      );
      if (status !== 'PENDING') grid.append(personField('결정일시', formatDate(pick(person, 'reviewedAt', 'ReviewedAt'))));
      card.append(head, grid);
      if (status === 'REJECTED') {
        card.append(personField('반려 사유', pick(person, 'reviewReason', 'reviewNote', 'ReviewReason', 'ReviewNote') || '-', true));
      }
      appendDocumentAction(card, applicationId, status === 'PENDING');
      list.append(card);
    });
  }

  function committeeDetailSlots(members, applications) {
    const role = row => pick(row, 'requestedRole', 'RequestedRole', 'role', 'Role');
    const status = row => String(pick(row, 'status', 'Status') || '').toUpperCase();
    const orderedMembers = [...members].sort((a, b) => asNumber(pick(a, 'seat', 'Seat')) - asNumber(pick(b, 'seat', 'Seat')));
    const pending = applications.filter(row => status(row) === 'PENDING');
    const chair = orderedMembers.find(row => role(row) === '위원장');
    const pendingChair = pending.find(row => role(row) === '위원장');
    const memberSlots = [
      ...orderedMembers.filter(row => role(row) === '위원').map(row => ({ member: row })),
      ...pending.filter(row => role(row) === '위원').map(row => ({ application: row })),
    ];
    return [
      chair ? { member: chair } : { application: pendingChair },
      memberSlots[0] ?? {},
      memberSlots[1] ?? {},
      { rejected: applications.filter(row => status(row) === 'REJECTED') },
    ];
  }

  function renderDetailSlots() {
    if (!state.detail) return;
    const slots = committeeDetailSlots(state.detail.members, state.detail.applications);
    const firstPending = slots.findIndex(slot => slot.application);
    const firstMember = slots.findIndex(slot => slot.member);
    if (activeDetailSlot === null || (activeDetailSlot === 3 && !slots[3].rejected.length)) {
      activeDetailSlot = firstPending >= 0 ? firstPending : Math.max(0, firstMember);
    }
    detailTabButtons.forEach((tab, index) => {
      const slot = slots[index];
      tab.hidden = index === 3 && !slot.rejected.length;
      tab.querySelector('span').textContent = slot.rejected ? `${slot.rejected.length}건`
        : slot.member ? '승인' : slot.application ? '대기' : '공석';
      tab.setAttribute('aria-selected', String(index === activeDetailSlot));
      tab.tabIndex = index === activeDetailSlot ? 0 : -1;
    });
    const slot = slots[activeDetailSlot];
    const applications = slot.application ? [slot.application] : slot.rejected ?? [];
    const panel = $('#detailSeatPanel');
    panel.setAttribute('aria-labelledby', detailTabButtons[activeDetailSlot].id);
    $('#detailMemberSection').hidden = !slot.member;
    $('#detailApplicationSection').hidden = !applications.length;
    $('#applicationTitle').textContent = slot.rejected ? '반려 이력' : '위원 가입 신청';
    $('#detailSeatEmpty').hidden = Boolean(slot.member || applications.length);
    renderMembers(slot.member ? [slot.member] : []);
    renderApplications(applications);
    detailTabs.hidden = false;
    panel.hidden = false;
    updateDecisionState();
  }

  function selectDetailSlot(index) {
    activeDetailSlot = index;
    renderDetailSlots();
    detailTabButtons[index].focus();
  }

  detailTabButtons.forEach((tab, index) => tab.addEventListener('click', () => selectDetailSlot(index)));
  detailTabs.addEventListener('keydown', event => {
    if (!['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const visible = detailTabButtons.filter(tab => !tab.hidden);
    const current = visible.indexOf(event.target);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
    selectDetailSlot(detailTabButtons.indexOf(visible[next]));
  });

  function updateDecisionState() {
    const pending = pendingApplications();
    const reviewed = pending.filter(row => state.reviewedDocuments.has(asNumber(pick(row, 'applicationId', 'ApplicationId')))).length;
    const allReviewed = pending.length > 0 && reviewed === pending.length;
    $('#decisionPanel').hidden = pending.length === 0;
    $('#approveButton').disabled = state.decisionBusy || !allReviewed;
    $('#rejectButton').disabled = state.decisionBusy || pending.length === 0;
    $('#approvalGate').classList.toggle('ready', allReviewed);
    $('#approvalGate').textContent = pending.length === 0
      ? '결정할 승인 대기 신청이 없습니다.'
      : allReviewed ? `대기 신청 ${pending.length}건의 서류를 모두 확인했습니다. 승인할 수 있습니다.`
        : `승인 전 사업자등록증 확인: ${reviewed} / ${pending.length}건`;
    $('#detailPendingCount').textContent = `${pending.length}명`;
  }

  documentDialog.addEventListener('close', () => {
    const preview = documentPreview;
    if (!preview) return;
    documentPreview = null;
    preview.controller.abort();
    for (const media of [documentImage, documentPdf]) {
      media.hidden = true;
      media.removeAttribute('src');
    }
    documentPdfDownload.hidden = true;
    documentPdfDownload.removeAttribute('href');
    if (preview.url) URL.revokeObjectURL(preview.url);
    if ($('#detailDialog').open) $(`[data-document-application="${preview.applicationId}"]`)?.focus();
  });

  async function reviewDocument(applicationId, pending) {
    if (documentPreview) return;
    const preview = { applicationId, controller: new AbortController(), url: '' };
    documentPreview = preview;
    setMessage(documentMessage, '사업자등록증을 불러오는 중입니다.');
    documentDialog.showModal();
    try {
      const response = await api(`/api/supervisor/applications/${applicationId}/document`, { raw: true, signal: preview.controller.signal });
      const sha256 = String(response.headers.get('X-Document-Sha256') || '').trim().toUpperCase();
      if (!/^[A-F0-9]{64}$/.test(sha256)) throw new Error('사업자등록증 검증 해시를 확인하지 못했습니다.');
      const blob = await response.blob();
      if (documentPreview !== preview || !documentDialog.open) return;
      const media = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(blob.type) ? documentImage
        : blob.type === 'application/pdf' ? documentPdf : null;
      if (!media) throw new Error('지원하지 않는 사업자등록증 파일 형식입니다.');
      preview.url = URL.createObjectURL(blob);
      media.src = preview.url;
      if (media === documentImage) {
        await documentImage.decode().catch(() => { throw new Error('이미지를 표시할 수 없습니다. 등록된 파일을 확인해 주세요.'); });
      }
      if (documentPreview !== preview || !documentDialog.open) return;
      media.hidden = false;
      if (media === documentPdf) {
        documentPdfDownload.href = preview.url;
        documentPdfDownload.hidden = false;
      }
      setMessage(documentMessage, '');
      if (pending) {
        state.reviewedDocuments.set(applicationId, sha256);
        renderDetailSlots();
        setMessage($('#detailMessage'), '사업자등록증을 열었습니다. 내용을 확인한 뒤 승인 여부를 결정해 주세요.', true);
      }
    } catch (error) {
      if (documentPreview === preview && documentDialog.open) setMessage(documentMessage, error.message);
    }
  }

  function normalizeDetail(payload) {
    const complex = pick(payload, 'complex', 'apartment', 'Complex', 'Apartment') || {};
    const members = pick(payload, 'members', 'approvedMembers', 'Members', 'ApprovedMembers') || [];
    const applications = pick(payload, 'applications', 'committeeApplications', 'Applications', 'CommitteeApplications') || [];
    return {
      complex,
      members: Array.isArray(members) ? members : [],
      applications: Array.isArray(applications) ? applications : [],
    };
  }

  async function loadDetail(kaptCode) {
    setMessage($('#detailMessage'), '상세 정보를 불러오는 중입니다.');
    $('#detailBody').setAttribute('aria-busy', 'true');
    try {
      const payload = await api(`/api/supervisor/complexes/${encodeURIComponent(kaptCode)}`);
      if (state.currentKaptCode !== kaptCode || !$('#detailDialog').open) return;
      state.detail = normalizeDetail(payload);
      state.currentKaptCode = kaptCode;
      state.reviewedDocuments.clear();
      const complex = state.detail.complex;
      const name = String(pick(complex, 'kaptName', 'KaptName') || '단지 위원회 상세');
      const address = String(pick(complex, 'address', 'baseAddress', 'Address', 'BaseAddress') || '-');
      $('#detailTitle').textContent = name;
      $('#detailAddress').textContent = address;
      $('#detailCode').textContent = String(pick(complex, 'kaptCode', 'KaptCode') || kaptCode);
      businessRegistrationInput.value = formatBusinessRegistration(complex.businessRegistrationNumber);
      businessRegistrationForm.hidden = false;
      const inferredStatus = normalizeStatus({
        ...complex,
        pendingCount: state.detail.applications.filter(row => String(pick(row, 'status', 'Status') || '').toUpperCase() === 'PENDING').length,
        approvedMemberCount: state.detail.members.length,
        rejectedCount: state.detail.applications.filter(row => String(pick(row, 'status', 'Status') || '').toUpperCase() === 'REJECTED').length,
      });
      $('#detailStatus').replaceChildren(statusBadge(inferredStatus));
      $('#detailMemberCount').textContent = `${state.detail.members.length}명`;
      renderDetailSlots();
      $('#decisionNote').open = false;
      $('#decisionReason').value = '';
      $('#reasonCount').textContent = '0';
      setMessage($('#detailMessage'), '');
      $('#detailBody').scrollTop = 0;
    } catch (error) {
      setMessage($('#detailMessage'), error.message);
    } finally { $('#detailBody').removeAttribute('aria-busy'); }
  }

  async function openDetail(kaptCode, applicationId) {
    if (!kaptCode) return;
    state.currentKaptCode = kaptCode;
    state.detail = { complex: {}, members: [], applications: [] };
    activeDetailSlot = null;
    state.reviewedDocuments.clear();
    $('#detailTitle').textContent = '단지 위원회 상세';
    $('#detailAddress').textContent = '';
    $('#detailCode').textContent = kaptCode;
    $('#detailStatus').textContent = '불러오는 중';
    $('#detailMemberCount').textContent = '-';
    $('#detailPendingCount').textContent = '-';
    businessRegistrationForm.reset();
    businessRegistrationForm.hidden = true;
    saveBusinessRegistration.disabled = false;
    $('#memberList').replaceChildren();
    $('#applicationList').replaceChildren();
    detailTabs.hidden = true;
    $('#detailSeatPanel').hidden = true;
    $('#decisionPanel').hidden = true;
    $('#detailDialog').showModal();
    await loadDetail(kaptCode);
    if (!applicationId || state.currentKaptCode !== kaptCode || !state.detail) return;
    const index = committeeDetailSlots(state.detail.members, state.detail.applications)
      .findIndex(slot => asNumber(pick(slot.application, 'applicationId', 'ApplicationId')) === applicationId);
    if (index >= 0) detailTabButtons[index].click();
  }

  function closeDetail() {
    if (state.decisionBusy) return;
    $('#detailDialog').close();
  }

  businessRegistrationForm.addEventListener('submit', async event => {
    event.preventDefault();
    const kaptCode = state.currentKaptCode;
    if (!kaptCode || saveBusinessRegistration.disabled) return;
    saveBusinessRegistration.disabled = true;
    try {
      const result = await api(`/api/supervisor/complexes/${encodeURIComponent(kaptCode)}/business-registration`, {
        method: 'PUT', body: JSON.stringify({ businessRegistrationNumber: businessRegistrationInput.value }),
      });
      if (state.currentKaptCode === kaptCode) {
        state.detail.complex.businessRegistrationNumber = result.businessRegistrationNumber;
        businessRegistrationInput.value = document.activeElement === businessRegistrationInput
          ? result.businessRegistrationNumber : formatBusinessRegistration(result.businessRegistrationNumber);
        setMessage($('#detailMessage'), '사업자등록번호를 저장했습니다.', true);
      }
      await loadComplexes();
    } catch (error) {
      if (state.currentKaptCode === kaptCode) setMessage($('#detailMessage'), error.message);
    } finally {
      if (state.currentKaptCode === kaptCode) saveBusinessRegistration.disabled = false;
    }
  });

  function confirmSupervisorAction({ title, message, action, reason = '', danger = false }) {
    if (decisionConfirmation.open) return Promise.resolve(false);
    $('#decisionConfirmationTitle').textContent = title;
    $('#decisionConfirmationMessage').textContent = message;
    const reasonBox = $('#decisionConfirmationReason');
    reasonBox.hidden = !reason;
    reasonBox.querySelector('p').textContent = reason;
    const confirm = $('#confirmDecision');
    confirm.textContent = action;
    confirm.classList.toggle('danger', danger);
    confirm.classList.toggle('primary', !danger);
    decisionConfirmation.returnValue = 'cancel';
    return new Promise(resolve => {
      decisionConfirmation.addEventListener('close', () => resolve(decisionConfirmation.returnValue === 'confirm'), { once: true });
      decisionConfirmation.showModal();
    });
  }

  async function submitDecision(decision) {
    if (state.decisionBusy || !state.currentKaptCode) return;
    const pending = pendingApplications();
    const reason = $('#decisionReason').value.trim();
    if (!pending.length) { setMessage($('#detailMessage'), '결정할 승인 대기 신청이 없습니다.'); return; }
    if (decision === 'REJECT' && !reason) {
      $('#decisionNote').open = true;
      $('#decisionReason').setCustomValidity('반려 사유를 입력해 주세요.');
      $('#decisionReason').reportValidity();
      $('#decisionReason').focus();
      return;
    }
    $('#decisionReason').setCustomValidity('');
    const reviewedDocuments = pending.map(row => {
      const applicationId = asNumber(pick(row, 'applicationId', 'ApplicationId'));
      const storedSha256 = String(pick(row, 'documentSha256', 'DocumentSha256') || '').trim().toUpperCase();
      return { applicationId, documentSha256: decision === 'APPROVE'
        ? state.reviewedDocuments.get(applicationId) || '' : storedSha256 };
    });
    if (decision === 'APPROVE' && reviewedDocuments.some(document => !document.documentSha256)) {
      setMessage($('#detailMessage'), '승인 전에 모든 사업자등록증을 열어 확인해 주세요.');
      return;
    }
    const name = $('#detailTitle').textContent;
    const kaptCode = state.currentKaptCode;
    const reject = decision === 'REJECT';
    const action = reject ? '반려' : '승인';
    if (!await confirmSupervisorAction({
      title: `가입 신청 ${action}`,
      message: `${name}의 승인 대기 신청 ${pending.length}건을 모두 ${action}하시겠습니까?`,
      action,
      reason: reject ? reason : '',
      danger: reject,
    })
        || state.decisionBusy || state.currentKaptCode !== kaptCode || !$('#detailDialog').open) return;
    state.decisionBusy = true;
    updateDecisionState();
    $('#closeDetailBottom').disabled = true;
    $('#closeDetailTop').disabled = true;
    setMessage($('#detailMessage'), decision === 'APPROVE' ? '승인 결과를 저장하는 중입니다.' : '반려 결과를 저장하는 중입니다.');
    try {
      const result = await api(`/api/supervisor/complexes/${encodeURIComponent(kaptCode)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason, reviewedDocuments }),
      });
      const message = String(pick(result, 'message', 'Message') ||
        (decision === 'APPROVE' ? '위원회 가입 신청을 승인했습니다.' : '위원회 가입 신청을 반려했습니다.'));
      await loadDetail(state.currentKaptCode);
      setMessage($('#detailMessage'), `${message} 알림과 이메일 발송이 순차적으로 진행됩니다.`, true);
      await loadComplexes();
      void refreshNotificationCount();
    } catch (error) {
      setMessage($('#detailMessage'), error.message);
    } finally {
      state.decisionBusy = false;
      $('#closeDetailBottom').disabled = false;
      $('#closeDetailTop').disabled = false;
      updateDecisionState();
    }
  }

  $('#filterForm').addEventListener('submit', event => {
    event.preventDefault();
    state.query = $('#queryInput').value.trim();
    state.status = $('#statusSelect').value;
    state.pageSize = asNumber($('#pageSizeSelect').value, 50);
    state.page = 1;
    void loadComplexes();
  });
  const workspaceTabs = [...document.querySelectorAll('.supervisor-tabs [role="tab"]')];
  const supervisorInquiryMessage = $('#supervisorInquiryMessage');
  let supervisorInquiryLoad = 0;

  function inquiryStatus(message, success = false) {
    setMessage(supervisorInquiryMessage, message, success);
    supervisorInquiryMessage.hidden = !message;
  }

  async function loadSupervisorInquiries(inquiryId) {
    const load = ++supervisorInquiryLoad;
    const session = state.token;
    const list = $('#supervisorInquiryList');
    try {
      const { inquiries } = await api(inquiryId ? `/api/supervisor/inquiries?id=${inquiryId}` : '/api/supervisor/inquiries');
      if (!session || session !== state.token || load !== supervisorInquiryLoad) return;
      list.replaceChildren();
      if (inquiryId) {
        const back = element('button', 'button secondary compact', '전체 문의 보기');
        back.type = 'button';
        back.addEventListener('click', () => void loadSupervisorInquiries());
        list.append(back);
      }
      if (!inquiries.length) list.append(element('p', 'muted', '조회된 문의가 없습니다.'));
      for (const inquiry of inquiries) {
        const card = element('article');
        card.append(element('h3', '', inquiry.title),
          element('p', 'muted', `${inquiry.complexName || '단지 정보 없음'} · ${formatDate(inquiry.createdAt)}`),
          element('p', '', inquiry.content));
        if (inquiry.hasImage) {
          const button = element('button', 'button secondary compact', '첨부 이미지 보기');
          button.type = 'button';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              const response = await api(`/api/supervisor/inquiries/${inquiry.id}/image`, { raw: true });
              const url = URL.createObjectURL(await response.blob());
              const image = element('img');
              image.alt = '문의 첨부 이미지';
              image.src = url;
              try {
                await image.decode();
                if (button.isConnected && state.token === session) button.replaceWith(image);
              } finally { URL.revokeObjectURL(url); }
            } catch (error) { inquiryStatus(error.message); button.disabled = false; }
          });
          card.append(button);
        }
        if (inquiry.reply) {
          card.append(element('h4', '', '답변'), element('p', '', inquiry.reply));
        } else {
          const form = element('form', 'inquiry-reply-form');
          const label = element('label', '', '답변');
          const reply = element('textarea');
          reply.required = true; reply.maxLength = 2000; reply.rows = 3;
          label.append(reply);
          const save = element('button', 'button primary compact', '답변 등록');
          save.type = 'submit';
          const actions = element('div', 'inquiry-reply-actions');
          actions.append(save);
          form.append(label, actions);
          reply.addEventListener('input', () => reply.setCustomValidity(''));
          form.addEventListener('submit', async event => {
            event.preventDefault();
            if (save.disabled || state.token !== session) return;
            const content = reply.value.trim();
            if (!content) {
              reply.setCustomValidity('답변 내용을 입력해 주세요.');
              reply.reportValidity();
              return;
            }
            save.disabled = true;
            try {
              const confirmed = await confirmSupervisorAction({
                title: '답변 등록',
                message: '이 문의에 답변을 등록하시겠습니까?',
                action: '등록',
              });
              if (!confirmed || state.token !== session) return;
              await api(`/api/supervisor/inquiries/${inquiry.id}/reply`, {
                method: 'POST', body: JSON.stringify({ reply: content }),
              });
              inquiryStatus('답변을 등록했습니다.', true);
              void refreshNotificationCount();
              await loadSupervisorInquiries();
            } catch (error) { inquiryStatus(error.message); }
            finally {
              save.disabled = false;
              if (save.isConnected && state.token === session) save.focus();
            }
          });
          card.append(form);
        }
        list.append(card);
      }
    } catch (error) {
      if (load === supervisorInquiryLoad && session === state.token) inquiryStatus(error.message);
    }
  }

  const supervisorNotifications = $('#supervisorNotifications');
  const notificationButton = $('#supervisorNotificationsButton');
  let notificationPage = 1;
  let notificationRequest = 0;
  let countInFlight = false;

  function setNotificationCount(total) {
    const badge = $('#supervisorNotificationCount');
    badge.hidden = total === 0;
    badge.textContent = String(total);
    notificationButton.setAttribute('aria-label', total ? `알림 ${total}건` : '알림');
  }

  async function refreshNotificationCount() {
    if (!state.token || document.hidden || countInFlight || supervisorNotifications.open) return;
    countInFlight = true;
    const session = state.token;
    const request = notificationRequest;
    try {
      const { total } = await api('/api/supervisor/notifications?passive=1');
      if (session === state.token && request === notificationRequest) setNotificationCount(total);
    } catch {
      // Keep the last confirmed count until the next refresh.
    } finally {
      countInFlight = false;
    }
  }

  async function loadNotifications(page) {
    const request = ++notificationRequest;
    const session = state.token;
    const status = $('#supervisorNotificationStatus');
    const list = $('#supervisorNotificationItems');
    const pagination = $('#supervisorNotificationPages');
    list.replaceChildren();
    pagination.hidden = true;
    status.textContent = '알림을 불러오는 중입니다.';
    const isCurrent = () => supervisorNotifications.open && session === state.token && request === notificationRequest;
    try {
      const { items, total } = await api(`/api/supervisor/notifications?page=${page}`);
      if (!isCurrent()) return;
      setNotificationCount(total);
      const pages = Math.max(1, Math.ceil(total / 50));
      if (page > pages) {
        void loadNotifications(pages);
        return;
      }
      notificationPage = page;
      status.textContent = total ? `처리할 알림 ${total}건` : '처리할 알림이 없습니다.';
      for (const item of items) {
        const application = item.kind === 'application';
        const title = application ? `${item.role} 승인 신청` : `문의 접수 · ${item.title || '제목 없음'}`;
        const row = element('li');
        const button = element('button', 'notification-item');
        button.type = 'button';
        button.append(element('strong', '', title),
          element('span', 'muted', `${item.complexName || item.kaptCode} · ${formatDate(item.createdAt)}`));
        button.addEventListener('click', () => {
          supervisorNotifications.close();
          if (application) void openDetail(item.kaptCode, item.id);
          else selectSupervisorTab($('#supervisorInquiriesTab'), true, item.id);
        });
        row.append(button);
        list.append(row);
      }
      pagination.hidden = pages === 1;
      $('#supervisorNotificationPrev').disabled = page === 1;
      $('#supervisorNotificationNext').disabled = page === pages;
      $('#supervisorNotificationPage').textContent = `${page} / ${pages}`;
    } catch (error) {
      if (isCurrent()) status.textContent = error.message;
    }
  }

  notificationButton.addEventListener('click', () => {
    supervisorNotifications.showModal();
    void loadNotifications(1);
  });
  $('#supervisorNotificationPrev').addEventListener('click', () => void loadNotifications(notificationPage - 1));
  $('#supervisorNotificationNext').addEventListener('click', () => void loadNotifications(notificationPage + 1));
  document.addEventListener('visibilitychange', () => void refreshNotificationCount());
  window.setInterval(() => void refreshNotificationCount(), 45_000);

  function selectSupervisorTab(tab, focus = false, inquiryId) {
    for (const item of workspaceTabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) tab.focus();
    if (tab.id === 'supervisorInquiriesTab') {
      inquiryStatus('');
      void loadSupervisorInquiries(inquiryId);
    } else void loadComplexes();
  }

  workspaceTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectSupervisorTab(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? workspaceTabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + workspaceTabs.length) % workspaceTabs.length;
      selectSupervisorTab(workspaceTabs[target], true);
    });
  });
  $('#refreshButton').addEventListener('click', () => {
    void refreshNotificationCount();
    const tab = workspaceTabs.find(item => item.getAttribute('aria-selected') === 'true');
    if (tab) selectSupervisorTab(tab);
  });
  $('#closeDetailTop').addEventListener('click', closeDetail);
  $('#closeDetailBottom').addEventListener('click', closeDetail);
  $('#approveButton').addEventListener('click', () => void submitDecision('APPROVE'));
  $('#rejectButton').addEventListener('click', () => void submitDecision('REJECT'));
  $('#decisionReason').addEventListener('input', event => {
    event.currentTarget.setCustomValidity('');
    $('#reasonCount').textContent = String(event.currentTarget.value.length);
  });
  $('#detailDialog').addEventListener('cancel', event => {
    if (state.decisionBusy) event.preventDefault();
  });
  $('#detailDialog').addEventListener('close', () => {
    decisionConfirmation.close('cancel');
    documentDialog.close();
    state.currentKaptCode = '';
    state.detail = null;
    state.reviewedDocuments.clear();
    setMessage($('#detailMessage'), '');
  });

})();
