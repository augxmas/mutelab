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

  async function createSession(force = false) {
    if (state.token && !force) return state.token;
    const response = await fetch('/api/supervisor/session', {
      credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '관리 화면 세션을 시작하지 못했습니다.');
    state.token = String(pick(payload, 'token', 'sessionToken', 'supervisorToken') || '');
    if (!state.token) throw new Error('관리 화면 세션 토큰을 받지 못했습니다.');
    return state.token;
  }

  async function api(path, options = {}, retried = false) {
    await createSession();
    const headers = new Headers(options.headers || {});
    headers.set('X-Supervisor-Token', state.token);
    headers.set('Accept', 'application/json');
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 && !retried) {
      state.token = '';
      await createSession(true);
      return api(path, options, true);
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
    $('#summaryTotal').textContent = total.toLocaleString('ko-KR');
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
      const actionCell = document.createElement('td');
      const button = element('button', 'button secondary compact', '상세보기');
      button.type = 'button';
      button.setAttribute('aria-label', `${kaptName} 위원회 상세보기`);
      button.disabled = !kaptCode;
      button.addEventListener('click', () => openDetail(kaptCode));
      actionCell.append(button);
      row.append(statusCell, nameCell, addressCell, pendingCell, memberCell, dateCell, actionCell);
      body.append(row);
    });
    $('#emptyState').hidden = items.length > 0;
  }

  async function loadComplexes() {
    if (state.listBusy) return;
    state.listBusy = true;
    $('#refreshButton').disabled = true;
    setMessage($('#pageMessage'), '단지 정보를 불러오는 중입니다.');
    try {
      const params = new URLSearchParams({
        query: state.query, status: state.status, page: String(state.page), pageSize: String(state.pageSize),
      });
      const payload = await api(`/api/supervisor/complexes?${params}`);
      const items = pick(payload, 'items', 'complexes', 'rows') || [];
      const safeItems = Array.isArray(items) ? items : [];
      state.total = asNumber(pick(payload, 'total', 'totalCount', 'Total', 'TotalCount'), safeItems.length);
      state.page = Math.max(1, asNumber(pick(payload, 'page', 'Page'), state.page));
      state.pageSize = Math.max(1, asNumber(pick(payload, 'pageSize', 'size', 'PageSize', 'Size'), state.pageSize));
      state.totalPages = Math.max(1, asNumber(pick(payload, 'totalPages', 'TotalPages'), Math.ceil(state.total / state.pageSize)));
      renderSummary(pick(payload, 'summary', 'counts', 'Summary', 'Counts') || {}, safeItems);
      renderComplexRows(safeItems);
      $('#resultMeta').textContent = `총 ${state.total.toLocaleString('ko-KR')}개 단지 · ${state.page}페이지`;
      $('#pageIndicator').textContent = `${state.page.toLocaleString('ko-KR')} / ${state.totalPages.toLocaleString('ko-KR')}`;
      $('#previousPage').disabled = state.page <= 1;
      $('#nextPage').disabled = state.page >= state.totalPages;
      setMessage($('#pageMessage'), '');
    } catch (error) {
      renderComplexRows([]);
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

  function renderMembers(members) {
    const list = $('#memberList');
    list.replaceChildren();
    members.forEach(row => {
      const person = combinedPerson(row);
      const card = element('article', 'person-card');
      const head = element('div', 'person-card-head');
      const title = document.createElement('div');
      title.append(element('strong', '', String(pick(person, 'name', 'Name') || '이름 미등록')),
        element('p', '', `${pick(person, 'role', 'Role') || '위원'} · 좌석 ${pick(person, 'seat', 'Seat') || '-'}`));
      head.append(title, statusBadge('APPROVED'));
      const grid = element('div', 'person-grid');
      grid.append(
        personField('이메일', pick(person, 'email', 'Email')),
        personField('모바일폰', pick(person, 'mobile', 'Mobile')),
        personField('연락처', pick(person, 'contact', 'Contact')),
        personField('주소', pick(person, 'address', 'Address'), true),
        personField('승인일시', formatDate(pick(person, 'approvedAt', 'ApprovedAt')), true),
      );
      card.append(head, grid);
      list.append(card);
    });
    $('#memberCount').textContent = `${members.length}명`;
    $('#memberEmpty').hidden = members.length > 0;
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
        element('p', '', `신청번호 ${applicationId || '-'} · ${pick(person, 'requestedRole', 'role', 'RequestedRole', 'Role') || '위원'}`));
      head.append(title, statusBadge(status));
      const grid = element('div', 'person-grid');
      grid.append(
        personField('이메일', pick(person, 'email', 'Email')),
        personField('모바일폰', pick(person, 'mobile', 'Mobile')),
        personField('연락처', pick(person, 'contact', 'Contact')),
        personField('주소', pick(person, 'address', 'Address'), true),
        personField('신청일시', formatDate(pick(person, 'submittedAt', 'SubmittedAt'))),
        personField('결정일시', formatDate(pick(person, 'reviewedAt', 'ReviewedAt'))),
      );
      card.append(head, grid);
      if (status === 'REJECTED') {
        card.append(personField('반려 사유', pick(person, 'reviewReason', 'reviewNote', 'ReviewReason', 'ReviewNote') || '-', true));
      }
      if (status === 'PENDING' && applicationId > 0) {
        const documentRow = element('div', 'document-row');
        const reviewed = state.reviewedDocuments.has(applicationId);
        const documentState = element('span', `document-state${reviewed ? ' reviewed' : ''}`,
          reviewed ? '서류 확인 완료' : '서류 확인 필요');
        const button = element('button', 'button secondary compact', reviewed ? '사업자등록증 다시 보기' : '사업자등록증 보기');
        button.type = 'button';
        button.addEventListener('click', () => reviewDocument(applicationId, button));
        documentRow.append(documentState, button);
        card.append(documentRow);
      }
      list.append(card);
    });
    $('#applicationCount').textContent = `${applications.length}건`;
    $('#applicationEmpty').hidden = applications.length > 0;
    updateDecisionState();
  }

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

  async function reviewDocument(applicationId, button) {
    const preview = window.open('about:blank', '_blank');
    if (!preview) {
      setMessage($('#detailMessage'), '사업자등록증을 확인하려면 브라우저의 팝업 차단을 해제해 주세요.');
      return;
    }
    preview.opener = null;
    preview.document.title = '사업자등록증 불러오는 중';
    preview.document.body.textContent = '사업자등록증을 안전하게 불러오는 중입니다.';
    button.disabled = true;
    setMessage($('#detailMessage'), '사업자등록증을 불러오는 중입니다.');
    try {
      const response = await api(`/api/supervisor/applications/${applicationId}/document`, { raw: true });
      const sha256 = String(response.headers.get('X-Document-Sha256') || '').trim().toUpperCase();
      if (!/^[A-F0-9]{64}$/.test(sha256)) throw new Error('사업자등록증 검증 해시를 확인하지 못했습니다.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      preview.location.replace(url);
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
      state.reviewedDocuments.set(applicationId, sha256);
      renderApplications(state.detail.applications);
      setMessage($('#detailMessage'), '사업자등록증을 열었습니다. 내용을 확인한 뒤 승인 여부를 결정해 주세요.', true);
    } catch (error) {
      preview.close();
      setMessage($('#detailMessage'), error.message);
    } finally { button.disabled = false; }
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
      state.detail = normalizeDetail(payload);
      state.currentKaptCode = kaptCode;
      state.reviewedDocuments.clear();
      const complex = state.detail.complex;
      const name = String(pick(complex, 'kaptName', 'KaptName') || '단지 위원회 상세');
      const address = String(pick(complex, 'address', 'baseAddress', 'Address', 'BaseAddress') || '-');
      $('#detailTitle').textContent = name;
      $('#detailAddress').textContent = address;
      $('#detailCode').textContent = String(pick(complex, 'kaptCode', 'KaptCode') || kaptCode);
      const inferredStatus = normalizeStatus({
        ...complex,
        pendingCount: state.detail.applications.filter(row => String(pick(row, 'status', 'Status') || '').toUpperCase() === 'PENDING').length,
        approvedMemberCount: state.detail.members.length,
        rejectedCount: state.detail.applications.filter(row => String(pick(row, 'status', 'Status') || '').toUpperCase() === 'REJECTED').length,
      });
      $('#detailStatus').replaceChildren(statusBadge(inferredStatus));
      $('#detailMemberCount').textContent = `${state.detail.members.length}명`;
      renderMembers(state.detail.members);
      renderApplications(state.detail.applications);
      $('#decisionReason').value = '';
      $('#reasonCount').textContent = '0';
      setMessage($('#detailMessage'), '');
      $('.dialog-body').scrollTop = 0;
    } catch (error) {
      setMessage($('#detailMessage'), error.message);
    } finally { $('#detailBody').removeAttribute('aria-busy'); }
  }

  async function openDetail(kaptCode) {
    if (!kaptCode) return;
    state.currentKaptCode = kaptCode;
    state.detail = { complex: {}, members: [], applications: [] };
    state.reviewedDocuments.clear();
    $('#detailTitle').textContent = '단지 위원회 상세';
    $('#detailAddress').textContent = '';
    $('#detailCode').textContent = kaptCode;
    $('#detailStatus').textContent = '불러오는 중';
    $('#detailMemberCount').textContent = '-';
    $('#detailPendingCount').textContent = '-';
    $('#memberList').replaceChildren();
    $('#applicationList').replaceChildren();
    $('#memberCount').textContent = '0명';
    $('#applicationCount').textContent = '0건';
    $('#memberEmpty').hidden = false;
    $('#applicationEmpty').hidden = false;
    $('#decisionPanel').hidden = true;
    $('#detailDialog').showModal();
    await loadDetail(kaptCode);
  }

  function closeDetail() {
    if (state.decisionBusy) return;
    $('#detailDialog').close();
  }

  async function submitDecision(decision) {
    if (state.decisionBusy || !state.currentKaptCode) return;
    const pending = pendingApplications();
    const reason = $('#decisionReason').value.trim();
    if (!pending.length) { setMessage($('#detailMessage'), '결정할 승인 대기 신청이 없습니다.'); return; }
    if (decision === 'REJECT' && !reason) {
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
    const confirmation = decision === 'APPROVE'
      ? `${name}의 승인 대기 신청 ${pending.length}건을 모두 승인하시겠습니까?`
      : `${name}의 승인 대기 신청 ${pending.length}건을 모두 반려하시겠습니까?\n\n반려 사유: ${reason}`;
    if (!window.confirm(confirmation)) return;
    state.decisionBusy = true;
    updateDecisionState();
    $('#closeDetailBottom').disabled = true;
    $('#closeDetailTop').disabled = true;
    setMessage($('#detailMessage'), decision === 'APPROVE' ? '승인 결과를 저장하는 중입니다.' : '반려 결과를 저장하는 중입니다.');
    try {
      const result = await api(`/api/supervisor/complexes/${encodeURIComponent(state.currentKaptCode)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason, reviewedDocuments }),
      });
      const message = String(pick(result, 'message', 'Message') ||
        (decision === 'APPROVE' ? '위원회 가입 신청을 승인했습니다.' : '위원회 가입 신청을 반려했습니다.'));
      await loadDetail(state.currentKaptCode);
      setMessage($('#detailMessage'), `${message} 알림과 이메일 발송이 순차적으로 진행됩니다.`, true);
      await loadComplexes();
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
  $('#previousPage').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; void loadComplexes(); } });
  $('#nextPage').addEventListener('click', () => { if (state.page < state.totalPages) { state.page += 1; void loadComplexes(); } });
  $('#refreshButton').addEventListener('click', () => void loadComplexes());
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
    state.currentKaptCode = '';
    state.detail = null;
    state.reviewedDocuments.clear();
    setMessage($('#detailMessage'), '');
  });

  void (async () => {
    try {
      await createSession();
      await loadComplexes();
    } catch (error) { setMessage($('#pageMessage'), error.message); }
  })();
})();
