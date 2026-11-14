// ==UserScript==
// @name         币安价格自动计算工具-实时采样稳态增强版
// @namespace    http://tampermonkey.net/
// @version      7.3.3
// @description  v7.2.21 + Ctrl+Alt 点成交记录一键下单，面板 UI 重做（分段布局 / 胶囊开关 / 状态条）。
// @author       Gemini
// @match        https://www.binance.com/*
// @match        https://www.binance.cn/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'binance_tracker_v729';
    const LEGACY_STORAGE_KEY = 'binance_tracker_v727';
    const WINDOW_BEFORE_MS = 10 * 60 * 60 * 1000;
    const WINDOW_AFTER_MS = 2 * 60 * 60 * 1000;
    const PANEL_ID = 'binance-auto-fill-panel';

    let cachedBalanceEl = null;
    let debounceTimer = null;
    let balanceObserver = null;
    let balancePollTimer = null;
    let balanceReconnectTimer = null;
    let panelEnsureTimer = null;
    let historyRefreshTimer = null;
    let syncFlashTimer = null;
    let goalToastTimer = null;
    let orderTableObserver = null;

    function loadState() {
        const raw =
            localStorage.getItem(STORAGE_KEY) ||
            localStorage.getItem(LEGACY_STORAGE_KEY);

        const baseState = {
            hasStartedTracking: true,
            baselineTotal: 0,
            hasAlertedGoal: false,
            presetF: '600',
            presetD: '2',
            presetTarget: '32768',
            calcNum1: '',
            autoBuy: true,
            autoConfirm: true,
            trackingAnchorTs: Date.now()
        };

        try {
            const parsed = raw ? JSON.parse(raw) : {};
            return {
                ...baseState,
                ...parsed,
                trackingAnchorTs: Number(parsed?.trackingAnchorTs) || Date.now()
            };
        } catch (error) {
            return baseState;
        }
    }

    let state = loadState();

    function saveState() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function beginTrackingSession() {
        state.hasStartedTracking = true;
        state.baselineTotal = 0;
        state.hasAlertedGoal = false;
        state.trackingAnchorTs = Date.now();
        saveState();
    }

    function debounce(fn, delay) {
        return function() {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => fn.apply(this, arguments), delay);
        };
    }

    function getTextContent(el) {
        return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function isVisible(el) {
        if (!el || !document.body.contains(el)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function parseBalanceToFixed(text) {
        const value = parseFloat(String(text).replace(/,/g, '').replace(/USDT/g, '').trim()) || 0;
        return value.toFixed(2);
    }

    function parseNumber(text) {
        const value = parseFloat(String(text).replace(/,/g, '').replace(/[^\d.-]/g, '').trim());
        return Number.isFinite(value) ? value : null;
    }

    function parseBinanceDate(text) {
        const normalized = String(text).replace(/\u00a0/g, ' ').trim();
        const match = normalized.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (!match) return null;

        const [, year, month, day, hour, minute, second = '0'] = match;
        const date = new Date(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second)
        );

        return Number.isNaN(date.getTime()) ? null : date;
    }

    function getTrackingWindow() {
        const anchor = Number(state.trackingAnchorTs) || Date.now();
        return {
            start: anchor - WINDOW_BEFORE_MS,
            end: anchor + WINDOW_AFTER_MS
        };
    }

    function getUi() {
        return {
            panel: document.getElementById(PANEL_ID),
            calcNum1: document.getElementById('calc-num1'),
            calcNum2: document.getElementById('calc-num2'),
            calcResultBox: document.getElementById('calc-result-box'),
            historyTotalBox: document.getElementById('history-total-box'),
            historyPreset: document.getElementById('history-preset'),
            inputA: document.getElementById('input-a'),
            inputF: document.getElementById('input-f'),
            inputD: document.getElementById('input-d'),
            windowTip: document.getElementById('tracking-window-tip')
        };
    }

    function flashInput(input, color) {
        if (!input) return;

        const className = color === '#02c076'
            ? 'bap-flash-ok'
            : color === '#f6465d' ? 'bap-flash-err' : 'bap-flash-warn';

        input.classList.remove('bap-flash-ok', 'bap-flash-err', 'bap-flash-warn');
        void input.offsetWidth;
        input.classList.add(className);

        setTimeout(() => input.classList.remove(className), 900);
    }

    function updateWindowTip() {
        const { windowTip } = getUi();
        if (!windowTip) return;

        const { start, end } = getTrackingWindow();
        const fmt = new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        windowTip.textContent = `统计窗口 ${fmt.format(start)} - ${fmt.format(end)}`;
    }

    function updateMath() {
        const { calcNum1, calcNum2, calcResultBox } = getUi();
        if (!calcNum1 || !calcNum2 || !calcResultBox) return;

        const before = parseFloat(calcNum1.value) || 0;
        const current = parseFloat(calcNum2.value) || 0;
        const result = before - current;

        calcResultBox.value = result.toFixed(2);
        calcResultBox.style.color = result >= 0 ? '#02c076' : '#f6465d';
    }

    function updateTargetGap() {
        const { historyPreset, historyTotalBox } = getUi();
        const targetGapBox = document.getElementById('target-gap-box');
        if (!historyPreset || !historyTotalBox || !targetGapBox) return;

        const preset = parseFloat(historyPreset.value) || 0;
        const total = parseFloat(historyTotalBox.value) || 0;
        const gap = (preset - total) / 4;
        targetGapBox.value = gap.toFixed(2);
        targetGapBox.style.color = gap >= 0 ? '#f0b90b' : '#f6465d';
    }

    function showGoalModal() {
        const existing = document.getElementById('binance-goal-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'binance-goal-modal';
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:2147483647',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'background:rgba(5,10,18,0.38)',
            'backdrop-filter:blur(4px)'
        ].join(';');

        overlay.innerHTML = `
            <div style="min-width:320px;max-width:420px;padding:22px 24px;border-radius:18px;background:linear-gradient(180deg,#18202a 0%,#0f151c 100%);border:1px solid #39414d;box-shadow:0 24px 80px rgba(0,0,0,0.45);text-align:center;color:#f5f7fa;">
                <div style="font-size:28px;font-weight:800;color:#f0b90b;letter-spacing:1px;">今日alpha已达标</div>
                <div style="margin-top:14px;font-size:12px;color:#7f8a99;">点击任意位置关闭</div>
            </div>
        `;

        overlay.addEventListener('click', () => overlay.remove(), { once: true });
        document.body.appendChild(overlay);

        clearTimeout(goalToastTimer);
        goalToastTimer = setTimeout(() => {
            overlay.remove();
        }, 9000);
    }

    function findBalanceElement() {
        if (isVisible(cachedBalanceEl)) return cachedBalanceEl;

        const directSelector = [
            'div.text-PrimaryText.text-\\[12px\\].leading-\\[18px\\].font-\\[500\\]',
            'span.text-PrimaryText.text-\\[12px\\].leading-\\[18px\\].font-\\[500\\]'
        ].join(', ');

        const directMatches = Array.from(document.querySelectorAll(directSelector)).filter(isVisible);
        const contextualMatch = directMatches.find((el) => {
            const selfText = getTextContent(el);
            const parentText = getTextContent(el.parentElement);
            const wrapText = getTextContent(el.closest('.bn-flex'));
            return (
                /^\d[\d,]*\.?\d*\s*USDT$/.test(selfText) &&
                /可用|Available|余额|Balance/.test(`${parentText} ${wrapText}`)
            );
        });

        if (contextualMatch) {
            cachedBalanceEl = contextualMatch;
            return cachedBalanceEl;
        }

        const candidates = Array.from(document.querySelectorAll('div, span, p')).filter((el) => {
            const text = getTextContent(el);
            if (!text || !text.includes('USDT') || !/\d/.test(text)) return false;
            if (!isVisible(el)) return false;
            return /可用|Available|余额|Balance/.test(getTextContent(el.parentElement) + ' ' + getTextContent(el.closest('.bn-flex')));
        });

        cachedBalanceEl =
            candidates.find((el) => /^\d[\d,]*\.?\d*\s*USDT$/.test(getTextContent(el))) ||
            null;

        return cachedBalanceEl;
    }

    function readCurrentBalanceValue(forceRescan = false) {
        if (forceRescan) cachedBalanceEl = null;
        const el = findBalanceElement();
        if (!el) return null;

        const text = getTextContent(el);
        const value = parseBalanceToFixed(text);
        if (value === '0.00' && !/\b0([.,]0+)?\s*USDT\b/.test(text)) return null;
        return value;
    }

    function applyBalanceValue(value, { syncStart = false } = {}) {
        const { calcNum1, calcNum2 } = getUi();
        if (!calcNum2) return false;

        if (syncStart && calcNum1) {
            calcNum1.value = value;
            state.calcNum1 = value;
            saveState();
            flashInput(calcNum1, '#f0b90b');
        }

        if (calcNum2.value !== value) {
            calcNum2.value = value;
            flashInput(calcNum2, '#02c076');
        }

        updateMath();
        return true;
    }

    function refreshBalance(options = {}) {
        const {
            forceRescan = false,
            syncStart = false,
            retries = 6,
            delay = 280
        } = options;

        let attempt = 0;

        const run = () => {
            const value = readCurrentBalanceValue(forceRescan || attempt > 0);
            if (value !== null) {
                applyBalanceValue(value, { syncStart });
                return;
            }

            if (attempt < retries) {
                attempt += 1;
                setTimeout(run, delay);
            }
        };

        run();
    }

    function disconnectBalanceWatchers() {
        if (balanceObserver) {
            balanceObserver.disconnect();
            balanceObserver = null;
        }
        if (balancePollTimer) {
            clearInterval(balancePollTimer);
            balancePollTimer = null;
        }
        if (balanceReconnectTimer) {
            clearInterval(balanceReconnectTimer);
            balanceReconnectTimer = null;
        }
    }

    function reconnectBalanceObserver() {
        disconnectBalanceWatchers();

        const attach = () => {
            const el = findBalanceElement();
            if (!el) return false;

            refreshBalance({ forceRescan: true, retries: 4, delay: 180 });

            balanceObserver = new MutationObserver(() => {
                refreshBalance({ retries: 1, delay: 100 });
            });
            balanceObserver.observe(el, { characterData: true, childList: true, subtree: true });

            balancePollTimer = setInterval(() => {
                if (!isVisible(el)) {
                    reconnectBalanceObserver();
                    return;
                }
                refreshBalance({ retries: 0 });
            }, 2000);

            balanceReconnectTimer = setInterval(() => {
                const latest = findBalanceElement();
                if (!latest || latest !== el) reconnectBalanceObserver();
            }, 3500);

            return true;
        };

        if (!attach()) {
            setTimeout(reconnectBalanceObserver, 1800);
        }
    }

    function extractRowDate(row) {
        const cells = Array.from(row.querySelectorAll('[aria-colindex], td, div, span'));
        for (const cell of cells) {
            const parsed = parseBinanceDate(getTextContent(cell));
            if (parsed) return parsed;
        }
        return null;
    }

    function isRowInTrackingWindow(rowDate) {
        if (!rowDate) return false;
        const { start, end } = getTrackingWindow();
        const ts = rowDate.getTime();
        return ts >= start && ts <= end;
    }

    function calculateHistoryTotalBuy() {
        const rows = document.querySelectorAll('.bn-web-table-row');
        if (!rows.length) return 0;

        let total = 0;

        for (const row of rows) {
            const directionText = getTextContent(row.querySelector('[aria-colindex="4"]'));
            const statusText = getTextContent(row.querySelector('[aria-colindex="13"]'));
            const rowDate = extractRowDate(row);

            const isBuy = directionText === '买入';
            const shouldCountStatus =
                statusText === '已成交' ||
                statusText === '部分成交' ||
                statusText === '已取消';
            if (!isBuy || !shouldCountStatus || !isRowInTrackingWindow(rowDate)) continue;

            const amount = parseNumber(getTextContent(row.querySelector('[aria-colindex="9"]')));
            if (amount !== null) total += amount;
        }

        return total * 4;
    }

    function disconnectOrderTableObserver() {
        if (orderTableObserver) {
            orderTableObserver.disconnect();
            orderTableObserver = null;
        }
    }

    function attachOrderTableObserver(forceRefreshAll) {
        disconnectOrderTableObserver();

        const target =
            document.querySelector('.bn-web-table-body') ||
            document.querySelector('.bn-web-table-container') ||
            document.querySelector('.bn-web-table');

        if (!target) {
            setTimeout(() => attachOrderTableObserver(forceRefreshAll), 1500);
            return;
        }

        orderTableObserver = new MutationObserver(() => {
            forceRefreshAll();
        });

        orderTableObserver.observe(target, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function safeFill(input, value) {
        if (!input || input.value === value) return;
        try {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
        } catch (error) {
            input.value = value;
        }
    }

    function getInputContextText(input) {
        if (!input) return '';

        const bits = [
            input.placeholder,
            input.getAttribute('aria-label'),
            input.name,
            input.id,
            input.getAttribute('data-testid'),
            input.closest('label')?.innerText,
            input.closest('[role="group"]')?.innerText,
            input.closest('.bn-input-group')?.innerText,
            input.parentElement?.innerText
        ];

        return bits
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function isTradeInput(input) {
        if (!input || !isVisible(input) || input.disabled || input.readOnly) return false;
        if (!['text', 'number', 'search', 'tel', 'decimal'].includes((input.type || 'text').toLowerCase())) return false;
        if (document.getElementById(PANEL_ID)?.contains(input)) return false;
        return true;
    }

    function collectTradeInputs() {
        return Array.from(document.querySelectorAll('input')).filter(isTradeInput);
    }

    function findPriceInput(side) {
        const directSelectors = side === 'buy'
            ? [
                '#limitPrice',
                'input[name="price"]',
                'input[id*="price"]',
                'input[placeholder*="价格"]',
                'input[placeholder*="Price"]'
            ]
            : [
                'input[id*="sell"]',
                'input[name*="sell"]',
                'input[placeholder*="卖出"]',
                'input[placeholder*="Sell"]',
                'input[placeholder*="反向"]'
            ];

        for (const selector of directSelectors) {
            const found = Array.from(document.querySelectorAll(selector)).find(isTradeInput);
            if (found) return found;
        }

        const inputs = collectTradeInputs();
        const scored = inputs
            .map((input) => ({ input, text: getInputContextText(input) }))
            .filter(({ text }) => text.includes('价格') || text.includes('price') || text.includes('限价') || text.includes('limit'));

        if (side === 'buy') {
            return scored.find(({ text }) => text.includes('买') || text.includes('buy'))?.input ||
                scored.find(({ text }) => !text.includes('卖') && !text.includes('sell'))?.input ||
                scored[0]?.input ||
                null;
        }

        return scored.find(({ text }) =>
            text.includes('卖') || text.includes('sell') || text.includes('反向') || text.includes('reverse')
        )?.input || null;
    }

    function scoreInputByContext(input, positiveHints, negativeHints = []) {
        const text = getInputContextText(input);
        if (!text) return Number.NEGATIVE_INFINITY;

        let score = 0;

        for (const hint of positiveHints) {
            if (text.includes(hint)) score += 3;
        }

        for (const hint of negativeHints) {
            if (text.includes(hint)) score -= 4;
        }

        if (text.includes('usdt')) score += 4;
        if (text.includes('total') || text.includes('value')) score += 5;
        if (text.includes('amount')) score -= 6;

        return score;
    }

    function findAmountInput() {
        const inputs = collectTradeInputs();
        const directSelectors = [
            'input[placeholder*="Total"]',
            'input[placeholder*="total"]',
            'input[placeholder*="USDT"]'
        ];

        for (const selector of directSelectors) {
            const found = Array.from(document.querySelectorAll(selector)).find((input) => {
                if (!isTradeInput(input)) return false;
                return scoreInputByContext(input, ['total', 'value', 'usdt'], ['amount']) > 0;
            });
            if (found) return found;
        }

        const scored = inputs
            .map((input) => ({
                input,
                score: scoreInputByContext(
                    input,
                    ['total', 'value', 'usdt'],
                    ['amount', 'max']
                )
            }))
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score);

        return scored[0]?.input || null;
    }

    function calculatePrices(priceA, deltaD) {
        const rawStr = String(priceA).trim();
        const valA = parseFloat(rawStr);
        if (isNaN(valA) || valA <= 0) return { priceB: null, priceC: null };

        const d = parseFloat(deltaD) || 0;
        const ratio = d / 10000;

        const parts = rawStr.split('.');
        let decimals = parts.length > 1 ? parts[1].length : 0;

        const valB = valA * (1 + ratio);
        const valC = valA * (1 - ratio);

        let strB = valB.toFixed(decimals);
        let strC = valC.toFixed(decimals);

        if (d !== 0 && (parseFloat(strB) === valA || parseFloat(strC) === valA)) {
            for (let extra = decimals + 1; extra <= Math.max(decimals + 4, 8); extra++) {
                strB = valB.toFixed(extra);
                strC = valC.toFixed(extra);
                if (parseFloat(strB) !== valA && parseFloat(strC) !== valA) break;
            }
        }

        return {
            priceB: strB,
            priceC: strC
        };
    }

    function doFill(priceValue) {
        const d = parseFloat(document.getElementById('input-d')?.value) || 0;
        const result = calculatePrices(priceValue, d);
        if (!result.priceB) return false;

        const buyPriceInput = findPriceInput('buy');

        if (buyPriceInput) safeFill(buyPriceInput, result.priceB);

        [80, 260, 700].forEach((delay) => {
            setTimeout(() => {
                const sellInput = findPriceInput('sell');
                const amountInput = findAmountInput();

                if (sellInput) safeFill(sellInput, result.priceC);
                if (amountInput) safeFill(amountInput, document.getElementById('input-f')?.value || '');
            }, delay);
        });

        return true;
    }

    // ===== 一键下单（Ctrl+Alt+点成交记录）=====

    const autoLock = {
        busy: false,
        token: 0,
        aborted: false
    };

    let autoListenersInstalled = false;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    let autoStatusTimer = null;

    function setAutoStatus(text, color = '#8b96a5') {
        const el = document.getElementById('auto-status');
        if (!el) return;

        el.textContent = text;
        el.style.color = color;
        el.classList.toggle('busy', color === '#f0b90b');

        const panel = document.getElementById(PANEL_ID);
        if (panel) {
            el.classList.toggle('below', panel.getBoundingClientRect().top < 46);
        }

        el.classList.add('show');

        clearTimeout(autoStatusTimer);
        if (color !== '#f0b90b') {
            autoStatusTimer = setTimeout(() => el.classList.remove('show'), 6000);
        }
    }

    function normalizePriceText(value) {
        return String(value ?? '').replace(/[\,\s]/g, '');
    }

    function sameNumber(a, b) {
        const left = parseFloat(normalizePriceText(a));
        const right = parseFloat(normalizePriceText(b));
        if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
        if (left === right) return true;
        return Math.abs(left - right) <= Math.max(Math.abs(right) * 1e-9, 1e-12);
    }

    function readPriceFromRowCells(node) {
        const cells = Array.from(node.children).filter((child) => getTextContent(child));
        if (cells.length !== 3) return null;

        if (!/^\d{1,2}:\d{2}:\d{2}$/.test(getTextContent(cells[0]))) return null;

        const priceText = normalizePriceText(getTextContent(cells[1]));
        return /^\d+(\.\d+)?$/.test(priceText) ? priceText : null;
    }

    function extractRowPrice(anchor) {
        let node = anchor;

        for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1) {
            const direct = readPriceFromRowCells(node);
            if (direct) return direct;
            node = node.parentElement;
        }

        node = anchor;
        for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1) {
            const text = getTextContent(node).replace(/,/g, '');
            if (text.length <= 80 && /^\d{1,2}:\d{2}:\d{2}\s/.test(text)) {
                const rest = text.replace(/^\d{1,2}:\d{2}:\d{2}\s*/, '');
                const match = rest.match(/^(\d+\.\d{2,8})(?!\d|[KMB])/i);
                if (match) return match[1];
            }
            node = node.parentElement;
        }

        return null;
    }

    function findBuySubmitButton(anchorInput) {
        const anchorTop = anchorInput.getBoundingClientRect().top;
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], div[class*="bn-button"]'));

        const candidates = nodes.filter((el) => {
            if (document.getElementById(PANEL_ID)?.contains(el)) return false;
            if (!isVisible(el)) return false;
            if (!/^买入(\s*[A-Z0-9]{2,12})?$/.test(getTextContent(el))) return false;

            const rect = el.getBoundingClientRect();
            return rect.top > anchorTop + 20 && rect.width > 80 && rect.height > 28;
        });

        candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        return candidates[0] || null;
    }

    function findConfirmDialog() {
        const direct = Array.from(document.querySelectorAll('[role="dialog"], div[class*="modal"], div[class*="Modal"]'))
            .find((el) => isVisible(el) && getTextContent(el).includes('委托价'));

        if (direct) return direct;

        const confirmButtons = Array.from(document.querySelectorAll('button, [role="button"], div'))
            .filter((el) => {
                if (!isVisible(el)) return false;
                const text = getTextContent(el);
                return text === '确认' || text === '确认下单';
            });

        for (const button of confirmButtons) {
            let node = button.parentElement;
            for (let depth = 0; depth < 6 && node && node !== document.body; depth += 1) {
                const text = getTextContent(node);
                if (text.includes('委托价') && text.length < 420) return node;
                node = node.parentElement;
            }
        }

        return null;
    }

    function findConfirmButton(dialog) {
        if (!dialog) return null;

        const hits = Array.from(dialog.querySelectorAll('button, [role="button"], div'))
            .filter((el) => {
                if (!isVisible(el)) return false;
                const text = getTextContent(el);
                return text === '确认' || text === '确认下单';
            });

        const button = hits.find((el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button');
        return button || hits[hits.length - 1] || null;
    }

    function dialogMatchesPrice(dialog, priceB) {
        const target = parseFloat(normalizePriceText(priceB));
        if (!Number.isFinite(target)) return false;

        const numbers = (getTextContent(dialog).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || [])
            .map((item) => parseFloat(item))
            .filter((item) => Number.isFinite(item));

        return numbers.some((item) => Math.abs(item - target) <= Math.abs(target) * 1e-6);
    }

    function abortAutoChain(message) {
        autoLock.aborted = true;
        autoLock.busy = false;
        autoLock.token += 1;
        setAutoStatus(`✗ ${message}`, '#f6465d');
    }

    async function runOneClickChain(anchorEl) {
        if (autoLock.busy) return;
        if (!document.getElementById(PANEL_ID)) return;

        const token = ++autoLock.token;
        autoLock.busy = true;
        autoLock.aborted = false;

        const dead = () => autoLock.aborted || token !== autoLock.token;

        try {
            if (findConfirmDialog()) {
                abortAutoChain('已有确认框未处理');
                return;
            }

            setAutoStatus('读取成交价…', '#f0b90b');
            const rowPrice = extractRowPrice(anchorEl);
            if (!rowPrice) {
                abortAutoChain('这不是成交记录行');
                return;
            }

            await sleep(110);
            if (dead()) return;

            const priceA = rowPrice;
            const d = parseFloat(document.getElementById('input-d')?.value) || 0;
            const { priceB, priceC } = calculatePrices(priceA, d);

            if (!priceB || !priceC) {
                abortAutoChain('价格计算失败');
                return;
            }

            const buyInput = findPriceInput('buy');
            if (!buyInput) {
                abortAutoChain('找不到买入价格框');
                return;
            }

            safeFill(buyInput, priceB);
            setAutoStatus(`A=${priceA} → 买 ${priceB}`, '#f0b90b');
            await sleep(150);
            if (dead()) return;

            const amountInput = findAmountInput();
            const amountValue = document.getElementById('input-f')?.value || '';
            if (amountInput && amountValue) safeFill(amountInput, amountValue);

            await sleep(60);
            if (dead()) return;

            let sellInput = findPriceInput('sell');
            if (!sellInput) {
                abortAutoChain('未出现反向订单价格，请勾选反向订单');
                return;
            }

            safeFill(sellInput, priceC);
            await sleep(120);
            if (dead()) return;

            if (!sameNumber(sellInput.value, priceC)) {
                safeFill(sellInput, priceC);
                await sleep(80);
            }
            if (dead()) return;

            if (!sameNumber(buyInput.value, priceB) || !sameNumber(sellInput.value, priceC)) {
                abortAutoChain('价格回填被覆盖，已中止');
                return;
            }

            const targetAmount = parseFloat(normalizePriceText(amountValue));
            const filledAmount = parseFloat(normalizePriceText(amountInput?.value));
            if (Number.isFinite(targetAmount) && targetAmount > 0 && Number.isFinite(filledAmount) && filledAmount > 0) {
                if (Math.abs(filledAmount - targetAmount) / targetAmount > 0.02) {
                    abortAutoChain('成交额与 F 不符，已中止');
                    return;
                }
            }

            if (state.autoBuy === false) {
                setAutoStatus('价格已填好，等你点买入', '#02c076');
                autoLock.busy = false;
                return;
            }

            const buyBtn = findBuySubmitButton(buyInput);
            if (!buyBtn) {
                abortAutoChain('找不到买入按钮');
                return;
            }

            buyBtn.click();
            setAutoStatus('已点买入，等确认框…', '#f0b90b');

            if (state.autoConfirm === false) {
                autoLock.busy = false;
                setAutoStatus('等你点确认', '#02c076');
                return;
            }

            let dialog = null;
            for (let attempt = 0; attempt < 25; attempt += 1) {
                await sleep(80);
                if (dead()) return;
                dialog = findConfirmDialog();
                if (dialog) break;
            }

            if (!dialog) {
                setAutoStatus('未出现确认框（可能已直接提交）', '#f0b90b');
                autoLock.busy = false;
                return;
            }

            if (!dialogMatchesPrice(dialog, priceB)) {
                abortAutoChain('确认框价格不符，已中止');
                return;
            }

            const confirmBtn = findConfirmButton(dialog);
            if (!confirmBtn) {
                abortAutoChain('找不到确认按钮');
                return;
            }

            if (dead()) return;
            confirmBtn.click();

            autoLock.busy = false;
            setAutoStatus(`✓ 已下单 ${priceB}`, '#02c076');
        } catch (error) {
            abortAutoChain('异常已中止');
        } finally {
            if (token === autoLock.token) autoLock.busy = false;
        }
    }

    function installAutoChainListeners() {
        if (autoListenersInstalled) return;
        autoListenersInstalled = true;

        document.addEventListener('click', (event) => {
            if (!event.ctrlKey || !event.altKey || event.shiftKey) return;
            if (document.getElementById(PANEL_ID)?.contains(event.target)) return;

            const price = extractRowPrice(event.target);
            if (!price) {
                setAutoStatus('✗ 不是成交记录行', '#f6465d');
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            runOneClickChain(event.target);
        }, true);

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !autoLock.busy) return;

            autoLock.aborted = true;
            autoLock.busy = false;
            autoLock.token += 1;
            setAutoStatus('已中止（Esc）', '#f6465d');
        }, true);
    }

    function startHistoryRefreshLoop(forceRefreshAll) {
        if (historyRefreshTimer) clearInterval(historyRefreshTimer);
        historyRefreshTimer = setInterval(() => {
            forceRefreshAll();
        }, 1000);
    }

    const PANEL_STYLE_ID = 'binance-auto-fill-style';

    function ensurePanelStyles() {
        if (document.getElementById(PANEL_STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = PANEL_STYLE_ID;
        style.textContent = `
#binance-auto-fill-panel{position:fixed;top:56%;right:18px;transform:translateY(-50%);width:316px;box-sizing:border-box;
  border-radius:15px;border:1px solid rgba(255,255,255,.08);color:#e8edf4;
  background:radial-gradient(120% 80% at 100% 0%,rgba(240,185,11,.09),rgba(240,185,11,0) 58%),linear-gradient(180deg,#161c25 0%,#0c1016 100%);
  box-shadow:0 22px 55px rgba(0,0,0,.58),0 0 0 1px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.05);
  font-family:"Segoe UI",system-ui,Arial,sans-serif;font-size:12px;z-index:2147483647;
  -webkit-font-smoothing:antialiased}
#binance-auto-fill-panel *{box-sizing:border-box}
.bap-head{display:flex;align-items:center;gap:6px;height:36px;padding:0 8px 0 6px;border-radius:14px 14px 0 0;
  border-bottom:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.018)}
.bap-drag{width:19px;height:19px;display:flex;align-items:center;justify-content:center;border-radius:6px;
  color:#586172;font-size:11px;cursor:move;user-select:none;transition:background .15s,color .15s}
.bap-drag:hover{background:rgba(255,255,255,.07);color:#9aa5b4}
.bap-title{font-size:10.5px;font-weight:700;letter-spacing:.4px;color:#cdd6e1;white-space:nowrap}
.bap-title b{color:#f0b90b;font-weight:700}
.bap-spacer{flex:1}
.bap-toggle{width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:7px;
  color:#7d8695;font-size:13px;line-height:1;cursor:pointer;user-select:none;transition:transform .2s,background .15s,color .15s}
.bap-toggle:hover{background:rgba(255,255,255,.07);color:#e8edf4}
.bap-toggle.collapsed{transform:rotate(-90deg)}
.bap-body{display:flex;flex-direction:column;gap:9px;padding:10px 10px 11px}
.bap-row{display:flex;align-items:flex-end;gap:8px}
.bap-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.bap-field>label{display:block;font-size:10px;color:#78828f;letter-spacing:.2px;text-align:center;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bap-input{width:100%;height:37px;padding:0 6px;border-radius:10px;border:1px solid #29313d;background:#0f141b;
  color:#e8edf4;font-size:14px;font-weight:700;text-align:center;outline:none;
  font-variant-numeric:tabular-nums;box-shadow:inset 0 1px 2px rgba(0,0,0,.25);
  transition:border-color .15s,box-shadow .15s,background .15s}
.bap-input:hover{border-color:#3a4553}
.bap-input:focus{border-color:#f0b90b;background:#0b1016;box-shadow:0 0 0 3px rgba(240,185,11,.13)}
.bap-input::placeholder{color:#4b5462;font-size:11px;font-weight:500}
.bap-input.amber{color:#f0b90b}
.bap-input.green{color:#2ad08a}
.bap-input.plain{background:#0a0e13;border-color:#202834;box-shadow:none;cursor:default}
.bap-input.plain:hover{border-color:#202834}
select.bap-input{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:20px;
  background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='6'%3E%3Cpath d='M1 1l3.5 3.5L8 1' fill='none' stroke='%237c8794' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 8px center}
.bap-switches{display:flex;align-items:center;gap:4px}
.bap-head .bap-switches{margin-left:2px}
.bap-switch{position:relative;display:inline-flex;align-items:center;gap:4px;height:23px;padding:0 7px 0 5px;border-radius:999px;
  border:1px solid #29313d;background:#0f141b;color:#8a94a2;font-size:10px;font-weight:600;
  cursor:pointer;user-select:none;transition:border-color .15s,background .15s,color .15s}
.bap-switch:hover{border-color:#3d4a5a;color:#c5cfdb}
.bap-switch>input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
.bap-switch .bap-dot{width:12px;height:12px;border-radius:4px;border:1px solid #3a4553;display:flex;
  align-items:center;justify-content:center;font-size:8px;line-height:1;color:transparent;transition:all .15s}
.bap-switch.on{border-color:rgba(2,192,118,.5);background:rgba(2,192,118,.1);color:#78e6ba}
.bap-switch.on .bap-dot{background:#02c076;border-color:#02c076;color:#04160e}
.bap-status{position:absolute;left:0;right:0;top:-33px;height:26px;line-height:24px;padding:0 10px;border-radius:9px;
  border:1px solid rgba(255,255,255,.1);background:rgba(13,18,25,.97);
  box-shadow:0 10px 26px rgba(0,0,0,.55);font-size:10.5px;color:#8a94a2;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;transform:translateY(4px);
  transition:opacity .18s ease,transform .18s ease;pointer-events:none;z-index:6}
.bap-status.show{opacity:1;transform:translateY(0)}
.bap-status.below{top:auto;bottom:-33px}
.bap-status::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;
  background:currentColor;margin-right:7px;vertical-align:1px;opacity:.85}
.bap-status.busy::before{animation:bapPulse .9s ease-in-out infinite}
@keyframes bapPulse{0%,100%{opacity:.25;transform:scale(.75)}50%{opacity:1;transform:scale(1.2)}}
.bap-div{height:1px;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.08),rgba(255,255,255,0))}
.bap-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.bap-sync{display:flex;align-items:flex-end;gap:5px}
.bap-sync .bap-field{flex:1}
.bap-op{color:#586172;font-size:12px;font-weight:700;padding-bottom:11px}
.bap-mini{display:inline-block;padding:0 5px;border-radius:5px;font-size:9px;font-weight:600;cursor:pointer;transition:background .15s}
.bap-mini.red{color:#f6465d;background:rgba(246,70,93,.12)}
.bap-mini.red:hover{background:rgba(246,70,93,.26)}
.bap-mini.amber{color:#f0b90b;background:rgba(240,185,11,.12)}
.bap-mini.amber:hover{background:rgba(240,185,11,.26)}
.bap-flash-ok{animation:bapOk .85s ease}
.bap-flash-err{animation:bapErr .85s ease}
.bap-flash-warn{animation:bapWarn .85s ease}
@keyframes bapOk{0%{border-color:#02c076;box-shadow:0 0 0 4px rgba(2,192,118,.25)}100%{border-color:#29313d;box-shadow:none}}
@keyframes bapErr{0%{border-color:#f6465d;box-shadow:0 0 0 4px rgba(246,70,93,.25)}100%{border-color:#29313d;box-shadow:none}}
@keyframes bapWarn{0%{border-color:#f0b90b;box-shadow:0 0 0 4px rgba(240,185,11,.25)}100%{border-color:#29313d;box-shadow:none}}
`;
        (document.head || document.documentElement).appendChild(style);
    }

    function buildPanelHtml() {
        const is65536Selected = state.presetTarget === '65536';
        return `
            <div class="bap-head">
                <div class="bap-drag" id="drag-handle" title="按住拖动面板">⠿</div>
                <div class="bap-title" title="Ctrl+Alt 点成交记录 = 一键下单">币安<b>刷分</b></div>
                <div class="bap-spacer"></div>
                <div class="bap-switches">
                    <label class="bap-switch" id="switch-auto-buy">
                        <input id="chk-auto-buy" type="checkbox">
                        <span class="bap-dot">✓</span>自动买入
                    </label>
                    <label class="bap-switch" id="switch-auto-confirm">
                        <input id="chk-auto-confirm" type="checkbox">
                        <span class="bap-dot">✓</span>自动确认
                    </label>
                </div>
                <div class="bap-toggle" id="btn-master-toggle" title="展开 / 收起">⌄</div>
            </div>
            <div class="bap-body">
                <div class="bap-row">
                    <div class="bap-field" style="width:76px;flex:none;">
                        <label>成交额 F</label>
                        <input id="input-f" class="bap-input" type="text" value="${state.presetF}" style="padding:0 4px;">
                    </div>
                    <div class="bap-field" style="width:64px;flex:none;">
                        <label title="1‱ = 0.01%，B = A × (1 + D/10000)">浮动 D(‱)</label>
                        <input id="input-d" class="bap-input amber" type="number" value="${state.presetD || '2'}" placeholder="2">
                    </div>
                    <div class="bap-field" style="flex:1;">
                        <label>价格 A · 点击粘贴</label>
                        <input id="input-a" class="bap-input" type="text" autocomplete="off" placeholder="回车填充">
                    </div>
                </div>

                <div id="foldable-area" style="display:flex;flex-direction:column;gap:9px;">
                    <div class="bap-div"></div>
                    <div class="bap-grid">
                        <div class="bap-field">
                            <label>预设目标</label>
                            <select id="history-preset" class="bap-input">
                                <option value="32768" ${is65536Selected ? '' : 'selected'}>32768</option>
                                <option value="65536" ${is65536Selected ? 'selected' : ''}>65536</option>
                            </select>
                        </div>
                        <div class="bap-field">
                            <label>目标差额</label>
                            <input id="target-gap-box" class="bap-input amber plain" type="text" readonly value="8192.00">
                        </div>
                        <div class="bap-field">
                            <label>成交总额 <span id="btn-reset-tracking" class="bap-mini red">重置</span></label>
                            <input id="history-total-box" class="bap-input green plain" type="text" readonly value="等待开始...">
                        </div>
                    </div>
                    <div class="bap-sync">
                        <div class="bap-field">
                            <label><span id="btn-sync-start" class="bap-mini amber">同步起点</span></label>
                            <input id="calc-num1" class="bap-input" type="text" value="${state.calcNum1}" placeholder="刷前">
                        </div>
                        <div class="bap-op">-</div>
                        <div class="bap-field">
                            <label>当前余额</label>
                            <input id="calc-num2" class="bap-input green" type="text" readonly placeholder="监听">
                        </div>
                        <div class="bap-op">=</div>
                        <div class="bap-field">
                            <label>本次消耗</label>
                            <input id="calc-result-box" class="bap-input amber plain" type="text" readonly value="0.00">
                        </div>
                    </div>
                </div>
            </div>
            <div class="bap-status" id="auto-status"></div>
        `;
    }

    function createUI() {
        if (document.getElementById(PANEL_ID)) return;

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        ensurePanelStyles();

        panel.innerHTML = buildPanelHtml();
        document.body.appendChild(panel);
        updateTargetGap();

        updateWindowTip();
        bindUiEvents(panel);

        const { calcNum1 } = getUi();
        reconnectBalanceObserver();
        refreshBalance({ forceRescan: true, retries: 8, delay: 220 });

        if (!calcNum1.value) {
            const current = readCurrentBalanceValue(true);
            if (current !== null) {
                calcNum1.value = current;
                state.calcNum1 = current;
                saveState();
            }
        }
        updateMath();
    }

    function bindUiEvents(panel) {
        const {
            inputA,
            inputF,
            inputD,
            historyTotalBox,
            historyPreset
        } = getUi();

        const forceRefreshAll = debounce(() => {
            refreshBalance({ retries: 1, delay: 120 });
            if (!state.hasStartedTracking) return;

            const currentTotal = calculateHistoryTotalBuy();
            const preset = parseFloat(historyPreset?.value) || 0;

            if (historyTotalBox) {
                historyTotalBox.value = currentTotal.toFixed(2);
                historyTotalBox.style.backgroundColor =
                    currentTotal >= preset && preset > 0 ? 'rgba(240,185,11,0.12)' : '';
            }
            updateTargetGap();

            if (currentTotal >= preset && preset > 0 && !state.hasAlertedGoal) {
                state.hasAlertedGoal = true;
                saveState();
                showGoalModal();
            }
        }, 120);

        const handle = panel.querySelector('#drag-handle');
        handle.onmousedown = (event) => {
            event.preventDefault();
            const offsetX = event.clientX - panel.offsetLeft;
            const offsetY = event.clientY - panel.offsetTop;

            const move = (ev) => {
                panel.style.left = `${ev.clientX - offsetX}px`;
                panel.style.top = `${ev.clientY - offsetY}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
            };

            document.addEventListener('mousemove', move);
            document.onmouseup = () => {
                document.removeEventListener('mousemove', move);
                document.onmouseup = null;
            };
        };

        if (inputF) {
            inputF.oninput = () => {
                state.presetF = inputF.value;
                saveState();
            };
        }

        if (inputD) {
            inputD.oninput = () => {
                state.presetD = inputD.value;
                saveState();
            };
        }

        const bindSwitch = (checkboxId, switchId, stateKey) => {
            const checkbox = document.getElementById(checkboxId);
            const wrapper = document.getElementById(switchId);
            if (!checkbox || !wrapper) return;

            checkbox.checked = state[stateKey] !== false;
            wrapper.classList.toggle('on', checkbox.checked);

            checkbox.onchange = () => {
                state[stateKey] = checkbox.checked;
                wrapper.classList.toggle('on', checkbox.checked);
                saveState();
            };
        };

        bindSwitch('chk-auto-buy', 'switch-auto-buy', 'autoBuy');
        bindSwitch('chk-auto-confirm', 'switch-auto-confirm', 'autoConfirm');

        if (inputA) {
            inputA.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (doFill(inputA.value.trim())) {
                    flashInput(inputA, '#02c076');
                } else {
                    flashInput(inputA, '#f6465d');
                }
            });
        }

        if (historyPreset) {
            historyPreset.onchange = () => {
                state.presetTarget = historyPreset.value;
                saveState();
                updateTargetGap();
                forceRefreshAll();
            };
        }

        panel.addEventListener('click', async (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('input, select, option, .bap-switch, .bap-toggle, .bap-status, #drag-handle, #btn-reset-tracking, #btn-sync-start')) return;

            try {
                const clipText = await navigator.clipboard.readText();
                if (clipText && !isNaN(clipText)) {
                    inputA.value = clipText;
                    if (doFill(clipText)) {
                        flashInput(inputA, '#02c076');
                        setTimeout(() => {
                            inputA.focus();
                            inputA.setSelectionRange(inputA.value.length, inputA.value.length);
                        }, 60);
                    }
                }
            } catch (error) {}
        });

        document.getElementById('btn-master-toggle').onclick = () => {
            const area = document.getElementById('foldable-area');
            const collapsed = area.style.display === 'none';
            area.style.display = collapsed ? 'flex' : 'none';
            document.getElementById('btn-master-toggle').classList.toggle('collapsed', !collapsed);
        };

        document.getElementById('btn-reset-tracking').onclick = () => {
            if (!confirm('重置统计数据？')) return;

            state.hasStartedTracking = false;
            state.baselineTotal = 0;
            state.hasAlertedGoal = false;
            state.trackingAnchorTs = Date.now();
            saveState();

            if (historyTotalBox) {
                historyTotalBox.value = '等待开始...';
                historyTotalBox.style.backgroundColor = '';
            }
            updateTargetGap();
            updateWindowTip();
        };

        document.getElementById('btn-sync-start').onclick = () => {
            refreshBalance({ forceRescan: true, syncStart: true, retries: 10, delay: 260 });
            setTimeout(() => {
                refreshBalance({ forceRescan: true, retries: 6, delay: 260 });
            }, 700);
            forceRefreshAll();
        };

        document.addEventListener('mousedown', (event) => {
            const button = event.target.closest('button');
            const isConfirmButton = button && getTextContent(button) === '确认';
            if (!isConfirmButton) return;

            setTimeout(forceRefreshAll, 1000);
            setTimeout(forceRefreshAll, 3000);
        }, true);

        attachOrderTableObserver(forceRefreshAll);
        installAutoChainListeners();
        startHistoryRefreshLoop(forceRefreshAll);
        forceRefreshAll();
    }

    function boot() {
        beginTrackingSession();
        updateWindowTip();
        createUI();
        panelEnsureTimer = setInterval(() => {
            if (!document.getElementById(PANEL_ID)) createUI();
        }, 2500);
    }

    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot, { once: true });
})();
