const hours = document.querySelector('#hours');
const rate = document.querySelector('#rate');
const laborCost = document.querySelector('#labor-cost');
const laborBar = document.querySelector('#labor-bar');
const subscriptionBar = document.querySelector('#subscription-bar');
const subscription = 200000;
const won = new Intl.NumberFormat('ko-KR');

function updateComparison() {
  const labor = Math.round((hours.valueAsNumber || 0) * (rate.valueAsNumber || 0));
  const max = Math.max(labor, subscription);
  const valid = hours.validity.valid && rate.validity.valid;
  laborCost.textContent = valid ? `${won.format(labor)}원` : '입력 범위를 확인해 주세요';
  laborBar.style.width = `${valid ? 100 * labor / max : 0}%`;
  subscriptionBar.style.width = `${valid ? 100 * subscription / max : 100}%`;
}

hours.addEventListener('input', updateComparison);
rate.addEventListener('input', updateComparison);
updateComparison();
