/**
 * FINFLOW — JavaScript Engine
 * Arquitetura: Module Pattern com estado centralizado
 * Princípio: Single source of truth, precisão decimal com inteiros (centavos)
 */

'use strict';

/* ============================================================
   STATE — Fonte única de verdade (armazenamento em centavos
   para eliminar erros de ponto flutuante)
   ============================================================ */
const State = {
  transactions: [],   // [{id, type, amount_cents, description, category_id, date, notes, fixed}]
  categories:   [],   // [{id, name, type, color, budget_cents}]
  goals:        [],   // [{id, name, target_cents, current_cents, deadline, priority}]
  alerts:       [],   // [{id, type, threshold, category_id, name}]
  period:       'current',
  activeView:   'dashboard',
};

/* ============================================================
   PERSISTENCE
   ============================================================ */
const Storage = {
  KEY: 'finflow_v2',
  save() {
    try {
      localStorage.setItem(this.KEY, JSON.stringify({
        transactions: State.transactions,
        categories: State.categories,
        goals: State.goals,
        alerts: State.alerts,
      }));
    } catch (e) { console.warn('Storage error:', e); }
  },
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.transactions) State.transactions = data.transactions;
      if (data.categories)   State.categories   = data.categories;
      if (data.goals)        State.goals         = data.goals;
      if (data.alerts)       State.alerts        = data.alerts;
    } catch (e) { console.warn('Storage load error:', e); }
  },
};

/* ============================================================
   FINANCE ENGINE — Lógica analítica pura
   ============================================================ */
const Finance = {

  /* Converte valor para centavos (evita float arithmetic errors) */
  toCents: v => Math.round(parseFloat(v) * 100) || 0,

  /* Formata centavos para Real Brasileiro */
  fmt(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const reais = Math.floor(abs / 100);
    const centavos = String(abs % 100).padStart(2, '0');
    const formatted = reais.toLocaleString('pt-BR');
    return `${sign}R$ ${formatted},${centavos}`;
  },

  /* Formata percentual */
  fmtPct: (v, decimals = 1) => `${(+v).toFixed(decimals).replace('.', ',')}%`,

  /* Filtra transações pelo período ativo */
  filterByPeriod(txs, period) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();

    const ranges = {
      current: [
        new Date(y, m, 1),
        new Date(y, m + 1, 0, 23, 59, 59),
      ],
      last: [
        new Date(y, m - 1, 1),
        new Date(y, m, 0, 23, 59, 59),
      ],
      quarter: [
        new Date(y, m - 2, 1),
        new Date(y, m + 1, 0, 23, 59, 59),
      ],
      year: [
        new Date(y, 0, 1),
        new Date(y, 11, 31, 23, 59, 59),
      ],
      all: [new Date(0), new Date(9999, 0, 1)],
    };

    const [start, end] = ranges[period] || ranges.current;
    return txs.filter(t => {
      const d = new Date(t.date + 'T00:00:00');
      return d >= start && d <= end;
    });
  },

  /* Métricas principais */
  calcMetrics(txs) {
    const income  = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount_cents, 0);
    const expense = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount_cents, 0);
    const balance = income - expense;
    const savingsRate = income > 0 ? ((income - expense) / income) * 100 : 0;
    return { income, expense, balance, savingsRate };
  },

  /* Burn rate: média mensal de despesas nos últimos 12 meses */
  calcBurnRate(allTxs) {
    const now = new Date();
    const months = {};
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      months[k] = 0;
    }
    allTxs.filter(t => t.type === 'expense').forEach(t => {
      const k = t.date.substring(0, 7);
      if (k in months) months[k] += t.amount_cents;
    });
    const vals = Object.values(months);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  },

  /* Runway: saldo atual / burn rate mensal */
  calcRunway(balanceCents, burnRate) {
    if (burnRate <= 0) return Infinity;
    return balanceCents / burnRate;
  },

  /* Agrupa despesas por categoria no período */
  byCategory(txs) {
    const map = {};
    txs.filter(t => t.type === 'expense').forEach(t => {
      map[t.category_id] = (map[t.category_id] || 0) + t.amount_cents;
    });
    return map;
  },

  /* Fluxo mensal para os últimos N meses */
  monthlyCashflow(allTxs, months = 6) {
    const result = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleString('pt-BR', { month: 'short', year: '2-digit' });
      const inc = allTxs.filter(t => t.type === 'income'  && t.date.startsWith(k)).reduce((s, t) => s + t.amount_cents, 0);
      const exp = allTxs.filter(t => t.type === 'expense' && t.date.startsWith(k)).reduce((s, t) => s + t.amount_cents, 0);
      result.push({ label, income: inc, expense: exp, net: inc - exp });
    }
    return result;
  },

  /* Projeção simples por média móvel */
  forecast(allTxs, horizon = 3) {
    const monthly = this.monthlyCashflow(allTxs, 6);
    const avgInc = monthly.reduce((s, m) => s + m.income, 0) / monthly.length;
    const avgExp = monthly.reduce((s, m) => s + m.expense, 0) / monthly.length;

    // Tendência linear (regressão simples)
    const n = monthly.length;
    const sumX = monthly.reduce((s, _, i) => s + i, 0);
    const sumY_inc = monthly.reduce((s, m, i) => s + m.income * i, 0);
    const sumY_exp = monthly.reduce((s, m, i) => s + m.expense * i, 0);
    const sumX2 = monthly.reduce((s, _, i) => s + i * i, 0);
    const denom = n * sumX2 - sumX * sumX;

    let slope_inc = 0, slope_exp = 0;
    if (denom !== 0) {
      slope_inc = (n * sumY_inc - sumX * monthly.reduce((s, m) => s + m.income, 0)) / denom;
      slope_exp = (n * sumY_exp - sumX * monthly.reduce((s, m) => s + m.expense, 0)) / denom;
    }

    const projIncome  = Math.max(0, avgInc  + slope_inc  * horizon);
    const projExpense = Math.max(0, avgExp  + slope_exp  * horizon);

    return {
      projIncomeTotal:  Math.round(projIncome  * horizon),
      projExpenseTotal: Math.round(projExpense * horizon),
      projBalanceDelta: Math.round((projIncome - projExpense) * horizon),
      monthlyInc: Math.round(projIncome),
      monthlyExp: Math.round(projExpense),
      growthRate: avgInc > 0 ? ((projIncome - avgInc) / avgInc) * 100 : 0,
    };
  },

  /* Análise de risco */
  riskMetrics(allTxs) {
    const monthly = this.monthlyCashflow(allTxs, 6);
    const incomes = monthly.map(m => m.income);
    const avgInc = incomes.reduce((a, b) => a + b, 0) / incomes.length || 1;

    // Volatilidade = desvio padrão / média (coeficiente de variação)
    const variance = incomes.reduce((s, v) => s + Math.pow(v - avgInc, 2), 0) / incomes.length;
    const volatility = Math.sqrt(variance) / avgInc * 100;

    // Despesas fixas / receita (período atual)
    const periodTxs = this.filterByPeriod(allTxs, 'current');
    const { income, expense } = this.calcMetrics(periodTxs);
    const fixedExp = periodTxs.filter(t => t.type === 'expense' && t.fixed).reduce((s, t) => s + t.amount_cents, 0);
    const fixedRatio = income > 0 ? (fixedExp / income) * 100 : 0;

    // Concentração de receita (HHI simplificado: maior fonte / total)
    const incomeTxs = periodTxs.filter(t => t.type === 'income');
    const maxIncome = incomeTxs.length > 0 ? Math.max(...incomeTxs.map(t => t.amount_cents)) : 0;
    const concentration = income > 0 ? (maxIncome / income) * 100 : 0;

    // Burn rate vs receita
    const burnRate = this.calcBurnRate(allTxs);
    const burnRatio = income > 0 ? (burnRate / income) * 100 : 0;

    return { volatility, fixedRatio, concentration, burnRatio };
  },

  /* Verifica alertas */
  checkAlerts(metrics, burnRate) {
    const triggered = [];
    const periodTxs = Finance.filterByPeriod(State.transactions, State.period);
    const catExp = Finance.byCategory(periodTxs);

    State.alerts.forEach(a => {
      let val, label;
      switch (a.type) {
        case 'saldo_min':
          val = metrics.balance;
          if (val < Finance.toCents(a.threshold)) {
            triggered.push({ alert: a, label: `Saldo atual ${Finance.fmt(val)} abaixo do mínimo ${Finance.fmt(Finance.toCents(a.threshold))}`, level: 'danger' });
          }
          break;
        case 'despesa_cat':
          val = catExp[a.category_id] || 0;
          if (val > Finance.toCents(a.threshold)) {
            const cat = State.categories.find(c => c.id === a.category_id);
            triggered.push({ alert: a, label: `Categoria "${cat?.name}" atingiu ${Finance.fmt(val)} (limite: ${Finance.fmt(Finance.toCents(a.threshold))})`, level: 'warning' });
          }
          break;
        case 'burnrate':
          if (burnRate > Finance.toCents(a.threshold)) {
            triggered.push({ alert: a, label: `Burn rate ${Finance.fmt(burnRate)}/mês acima do limite ${Finance.fmt(Finance.toCents(a.threshold))}`, level: 'warning' });
          }
          break;
        case 'savings_rate':
          if (metrics.savingsRate < parseFloat(a.threshold)) {
            triggered.push({ alert: a, label: `Taxa de poupança ${Finance.fmtPct(metrics.savingsRate)} abaixo de ${a.threshold}%`, level: 'danger' });
          }
          break;
      }
    });
    return triggered;
  },

  /* Saúde financeira geral */
  healthScore(metrics, burnRate, risk) {
    let score = 100;
    if (metrics.balance < 0)                score -= 40;
    if (metrics.savingsRate < 10)           score -= 20;
    if (metrics.savingsRate < 0)            score -= 20;
    if (risk.fixedRatio > 70)              score -= 15;
    if (risk.volatility > 50)             score -= 10;
    if (burnRate > metrics.income * 0.9)  score -= 10;
    return Math.max(0, score);
  },
};

/* ============================================================
   ID GENERATOR
   ============================================================ */
const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/* ============================================================
   CHARTS
   ============================================================ */
let cashflowChart = null, categoryChart = null, forecastChart = null;

const Charts = {
  GRID_COLOR: 'rgba(255,255,255,0.04)',
  FONT_COLOR: '#4a5568',

  defaults() {
    Chart.defaults.color = this.FONT_COLOR;
    Chart.defaults.font.family = "'IBM Plex Mono', monospace";
    Chart.defaults.font.size = 11;
  },

  buildCashflow(data) {
    const ctx = document.getElementById('cashflow-chart');
    if (!ctx) return;
    if (cashflowChart) cashflowChart.destroy();

    cashflowChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => d.label),
        datasets: [
          {
            label: 'Receitas',
            data: data.map(d => d.income / 100),
            backgroundColor: 'rgba(52,211,153,0.7)',
            borderColor: '#34d399',
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: 'Despesas',
            data: data.map(d => d.expense / 100),
            backgroundColor: 'rgba(248,113,113,0.7)',
            borderColor: '#f87171',
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: this.GRID_COLOR }, ticks: { color: this.FONT_COLOR } },
          y: {
            grid: { color: this.GRID_COLOR },
            ticks: {
              color: this.FONT_COLOR,
              callback: v => `R$${v.toLocaleString('pt-BR')}`,
            },
          },
        },
      },
    });
  },

  buildCategory(catExpenses) {
    const ctx = document.getElementById('category-chart');
    if (!ctx) return;
    if (categoryChart) categoryChart.destroy();

    const cats = State.categories.filter(c => catExpenses[c.id] > 0);
    if (cats.length === 0) { categoryChart = null; return; }

    const total = cats.reduce((s, c) => s + catExpenses[c.id], 0);

    categoryChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: cats.map(c => c.name),
        datasets: [{
          data: cats.map(c => catExpenses[c.id] / 100),
          backgroundColor: cats.map(c => c.color + 'cc'),
          borderColor: cats.map(c => c.color),
          borderWidth: 1.5,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: { legend: { display: false }, tooltip: {
          callbacks: { label: c => ` R$ ${c.raw.toLocaleString('pt-BR', {minimumFractionDigits:2})}` }
        }},
      },
    });

    // Custom legend
    const legend = document.getElementById('donut-legend');
    if (legend) {
      legend.innerHTML = cats.map(c => {
        const pct = total > 0 ? ((catExpenses[c.id] / total) * 100).toFixed(1) : '0.0';
        return `<div class="donut-legend-item">
          <span class="donut-legend-dot" style="background:${c.color}"></span>
          <span>${c.name}</span>
          <span class="donut-legend-pct">${pct}%</span>
        </div>`;
      }).join('');
    }
  },

  buildForecast(allTxs) {
    const ctx = document.getElementById('forecast-chart');
    if (!ctx) return;
    if (forecastChart) forecastChart.destroy();

    const historical = Finance.monthlyCashflow(allTxs, 6);
    const fc = Finance.forecast(allTxs, 6);

    let runningBalance = Finance.calcMetrics(Finance.filterByPeriod(allTxs, 'current')).balance;
    const futureMonths = [];
    const now = new Date();
    for (let i = 1; i <= 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      futureMonths.push(d.toLocaleString('pt-BR', { month: 'short', year: '2-digit' }));
      runningBalance += fc.monthlyInc - fc.monthlyExp;
    }

    const histLabels = historical.map(m => m.label);
    const histBalances = historical.reduce((acc, m) => {
      const prev = acc.length > 0 ? acc[acc.length - 1] : 0;
      acc.push(prev + m.net / 100);
      return acc;
    }, []);

    forecastChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [...histLabels, ...futureMonths],
        datasets: [
          {
            label: 'Saldo Realizado',
            data: [...histBalances, ...new Array(6).fill(null)],
            borderColor: '#3d7fff',
            backgroundColor: 'rgba(61,127,255,0.08)',
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: '#3d7fff',
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Saldo Projetado',
            data: [...new Array(6).fill(null), ...(() => {
              const arr = [];
              let bal = histBalances[histBalances.length - 1] || 0;
              for (let i = 0; i < 6; i++) {
                bal += (fc.monthlyInc - fc.monthlyExp) / 100;
                arr.push(Math.round(bal * 100) / 100);
              }
              return arr;
            })()],
            borderColor: '#34d399',
            borderDash: [6, 4],
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: '#34d399',
            fill: false,
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#7d8fab', boxWidth: 12 } },
          tooltip: { callbacks: { label: c => ` R$ ${c.raw?.toLocaleString('pt-BR', {minimumFractionDigits:2}) ?? ''}` } },
        },
        scales: {
          x: { grid: { color: Charts.GRID_COLOR }, ticks: { color: Charts.FONT_COLOR } },
          y: { grid: { color: Charts.GRID_COLOR }, ticks: { color: Charts.FONT_COLOR, callback: v => `R$${v.toLocaleString('pt-BR')}` } },
        },
      },
    });
  },
};

/* ============================================================
   UI HELPERS
   ============================================================ */
const UI = {
  $ : id => document.getElementById(id),
  $q: sel => document.querySelector(sel),

  set(id, val) {
    const el = this.$(id);
    if (el) el.textContent = val;
  },

  toast(msg, type = 'success') {
    const wrap = this.$('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  },

  openModal(id) {
    const el = this.$(id);
    if (el) el.classList.add('active');
  },

  closeModal(id) {
    const el = this.$(id);
    if (el) el.classList.remove('active');
  },

  updateDate() {
    const now = new Date();
    const el = this.$('date-display');
    if (el) el.textContent = now.toLocaleDateString('pt-BR', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
    }).toUpperCase();
  },

  populateCategorySelects() {
    const selects = [
      this.$('tx-category'),
      this.$('filter-cat'),
      this.$('alert-cat'),
    ].filter(Boolean);

    selects.forEach(sel => {
      const current = sel.value;
      const isFilter = sel.id === 'filter-cat';
      sel.innerHTML = isFilter
        ? '<option value="all">Todas as Categorias</option>'
        : '<option value="">Selecionar...</option>';
      State.categories.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        sel.appendChild(opt);
      });
      if (current) sel.value = current;
    });
  },

  fmtDate: iso => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  },
};

/* ============================================================
   RENDER FUNCTIONS
   ============================================================ */
const Render = {

  dashboard() {
    const periodTxs = Finance.filterByPeriod(State.transactions, State.period);
    const metrics   = Finance.calcMetrics(periodTxs);
    const burnRate  = Finance.calcBurnRate(State.transactions);
    const runway    = Finance.calcRunway(metrics.balance, burnRate);
    const risk      = Finance.riskMetrics(State.transactions);
    const triggered = Finance.checkAlerts(metrics, burnRate);
    const health    = Finance.healthScore(metrics, burnRate, risk);

    // KPIs
    UI.set('kpi-saldo',    Finance.fmt(metrics.balance));
    UI.set('kpi-receitas', Finance.fmt(metrics.income));
    UI.set('kpi-despesas', Finance.fmt(metrics.expense));
    UI.set('kpi-burnrate', Finance.fmt(Math.round(burnRate)));
    UI.set('kpi-savings-rate', Finance.fmtPct(metrics.savingsRate));
    UI.set('kpi-runway', isFinite(runway) ? `${runway.toFixed(1).replace('.', ',')} meses` : '∞ meses');

    // Delta saldo
    const prevTxs = Finance.filterByPeriod(State.transactions, 'last');
    const prevMetrics = Finance.calcMetrics(prevTxs);
    const delta = metrics.balance - prevMetrics.balance;
    const deltaEl = UI.$('kpi-saldo-delta');
    if (deltaEl) {
      deltaEl.textContent = delta !== 0
        ? `${delta > 0 ? '▲' : '▼'} ${Finance.fmt(Math.abs(delta))} vs mês anterior`
        : 'Sem dados do mês anterior';
      deltaEl.className = `kpi-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`;
    }

    // Health indicator
    const dot   = document.querySelector('.health-dot');
    const label = document.querySelector('.health-label');
    if (dot && label) {
      if (health >= 70) { dot.className = 'health-dot'; label.textContent = 'Saudável'; }
      else if (health >= 40) { dot.className = 'health-dot warning'; label.textContent = 'Atenção'; }
      else { dot.className = 'health-dot danger'; label.textContent = 'Crítico'; }
    }

    // Alert badge
    const badge = UI.$('alert-badge');
    if (badge) {
      if (triggered.length > 0) { badge.textContent = triggered.length; badge.classList.add('visible'); }
      else { badge.classList.remove('visible'); }
    }

    // Recent transactions
    const recentList = UI.$('recent-tx-list');
    if (recentList) {
      const recent = [...State.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
      if (recent.length === 0) {
        recentList.innerHTML = '<div class="empty-state">Nenhuma transação registrada</div>';
      } else {
        recentList.innerHTML = recent.map(t => this._txItem(t)).join('');
      }
    }

    // Goals
    const dashGoals = UI.$('dash-goals-list');
    if (dashGoals) {
      if (State.goals.length === 0) {
        dashGoals.innerHTML = '<div class="empty-state">Nenhuma meta cadastrada</div>';
      } else {
        dashGoals.innerHTML = State.goals.slice(0, 4).map(g => {
          const pct = Math.min(100, g.target_cents > 0 ? (g.current_cents / g.target_cents) * 100 : 0);
          return `<div class="goal-item">
            <div class="goal-header">
              <span class="goal-name">${g.name}</span>
              <span class="goal-pct">${pct.toFixed(1).replace('.', ',')}%</span>
            </div>
            <div class="goal-bar-wrap"><div class="goal-bar" style="width:${pct}%"></div></div>
            <div class="goal-sub">
              <span>${Finance.fmt(g.current_cents)}</span>
              <span>${Finance.fmt(g.target_cents)}</span>
            </div>
          </div>`;
        }).join('');
      }
    }

    // Risk panel
    const riskData = [
      { id: 'risk-concentration', valId: 'risk-conc-val', val: risk.concentration },
      { id: 'risk-fixed',         valId: 'risk-fixed-val', val: risk.fixedRatio },
      { id: 'risk-vol',           valId: 'risk-vol-val',   val: risk.volatility },
      { id: 'risk-burn',          valId: 'risk-burn-val',  val: risk.burnRatio },
    ];
    riskData.forEach(r => {
      const bar = UI.$(r.id);
      const val = UI.$(r.valId);
      if (bar) bar.style.width = Math.min(100, r.val).toFixed(1) + '%';
      if (val) val.textContent = Finance.fmtPct(r.val);
    });

    // Charts
    Charts.buildCashflow(Finance.monthlyCashflow(State.transactions, 6));
    Charts.buildCategory(Finance.byCategory(periodTxs));
  },

  transactions() {
    const type   = UI.$('filter-type')?.value || 'all';
    const catId  = UI.$('filter-cat')?.value || 'all';
    const search = (UI.$('filter-search')?.value || '').toLowerCase().trim();

    let txs = [...State.transactions].sort((a, b) => b.date.localeCompare(a.date));
    if (type !== 'all')   txs = txs.filter(t => t.type === type);
    if (catId !== 'all')  txs = txs.filter(t => t.category_id === catId);
    if (search)           txs = txs.filter(t => t.description.toLowerCase().includes(search) || (t.notes || '').toLowerCase().includes(search));

    const tbody = UI.$('tx-table-body');
    if (!tbody) return;

    if (txs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhuma transação encontrada</td></tr>';
      return;
    }

    tbody.innerHTML = txs.map(t => {
      const cat = State.categories.find(c => c.id === t.category_id);
      const isIncome = t.type === 'income';
      return `<tr>
        <td style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">${UI.fmtDate(t.date)}</td>
        <td>
          ${t.description}
          ${t.fixed ? '<span class="tag tag-fixed">Fixo</span>' : ''}
          ${t.notes ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${t.notes}</div>` : ''}
        </td>
        <td>
          ${cat ? `<span style="display:inline-flex;align-items:center;gap:6px">
            <span style="width:8px;height:8px;background:${cat.color};border-radius:50%;display:inline-block"></span>
            ${cat.name}
          </span>` : '<span style="color:var(--text-muted)">—</span>'}
        </td>
        <td><span class="tag ${isIncome ? 'tag-income' : 'tag-expense'}">${isIncome ? 'Receita' : 'Despesa'}</span></td>
        <td class="text-right ${isIncome ? 'positive' : 'negative'}">${Finance.fmt(t.amount_cents)}</td>
        <td>
          <button class="btn-icon" onclick="App.editTransaction('${t.id}')" title="Editar">✎</button>
          <button class="btn-icon delete" onclick="App.deleteTransaction('${t.id}')" title="Excluir">✕</button>
        </td>
      </tr>`;
    }).join('');
  },

  categories() {
    const grid = UI.$('categories-grid');
    if (!grid) return;

    if (State.categories.length === 0) {
      grid.innerHTML = '<div class="empty-state">Nenhuma categoria criada</div>';
      return;
    }

    const periodTxs = Finance.filterByPeriod(State.transactions, State.period);
    const catExp = Finance.byCategory(periodTxs);
    const catInc = {};
    periodTxs.filter(t => t.type === 'income').forEach(t => {
      catInc[t.category_id] = (catInc[t.category_id] || 0) + t.amount_cents;
    });

    grid.innerHTML = State.categories.map(c => {
      const spent  = catExp[c.id] || 0;
      const earned = catInc[c.id] || 0;
      const budgetPct = c.budget_cents > 0 ? Math.min(100, (spent / c.budget_cents) * 100) : 0;
      const typeLabel = { expense: 'Despesa', income: 'Receita', both: 'Ambos' }[c.type] || c.type;

      return `<div class="cat-card">
        <div class="cat-color-bar" style="background:${c.color}"></div>
        <div class="cat-actions">
          <button class="btn-icon" onclick="App.editCategory('${c.id}')" title="Editar">✎</button>
          <button class="btn-icon delete" onclick="App.deleteCategory('${c.id}')" title="Excluir">✕</button>
        </div>
        <div class="cat-name">${c.name}</div>
        <div class="cat-type">${typeLabel}</div>
        <div class="cat-budget-info">
          ${spent > 0 ? `Gasto: ${Finance.fmt(spent)}` : ''}
          ${earned > 0 ? `Recebido: ${Finance.fmt(earned)}` : ''}
          ${c.budget_cents > 0 ? `<div style="margin-top:8px">
            <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-muted);margin-bottom:4px">
              <span>Orçamento</span><span>${budgetPct.toFixed(1)}%</span>
            </div>
            <div class="goal-bar-wrap"><div class="goal-bar" style="width:${budgetPct}%;background:${budgetPct > 90 ? 'var(--negative)' : budgetPct > 70 ? 'var(--warning)' : c.color}"></div></div>
            <div style="text-align:right;margin-top:3px;font-size:10.5px">${Finance.fmt(c.budget_cents)}</div>
          </div>` : ''}
        </div>
      </div>`;
    }).join('');
  },

  goals() {
    const grid = UI.$('goals-grid');
    if (!grid) return;

    if (State.goals.length === 0) {
      grid.innerHTML = '<div class="empty-state">Nenhuma meta cadastrada</div>';
      return;
    }

    grid.innerHTML = State.goals.map(g => {
      const pct = g.target_cents > 0 ? Math.min(100, (g.current_cents / g.target_cents) * 100) : 0;
      const remaining = g.target_cents - g.current_cents;
      const priorityMap = { high: 'Alta', medium: 'Média', low: 'Baixa' };
      let monthsLeft = '—';
      if (g.deadline) {
        const days = Math.ceil((new Date(g.deadline + 'T00:00:00') - new Date()) / 86400000);
        monthsLeft = days > 0 ? `${Math.ceil(days / 30)} meses` : 'Vencida';
      }
      const monthly = g.deadline && remaining > 0 ? (() => {
        const days = Math.ceil((new Date(g.deadline + 'T00:00:00') - new Date()) / 86400000);
        const months = Math.max(1, Math.ceil(days / 30));
        return Finance.fmt(Math.round(remaining / months));
      })() : '—';

      return `<div class="goal-card">
        <span class="priority-badge priority-${g.priority}">${priorityMap[g.priority]}</span>
        <div class="goal-card-name">${g.name}</div>
        <div class="goal-card-target">${Finance.fmt(g.target_cents)}</div>
        <div class="goal-card-progress">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:6px">
            <span>${Finance.fmt(g.current_cents)} acumulados</span>
            <span>${pct.toFixed(1).replace('.', ',')}%</span>
          </div>
          <div class="goal-bar-wrap" style="height:6px"><div class="goal-bar" style="width:${pct}%"></div></div>
        </div>
        <div class="goal-card-meta">
          <div class="goal-meta-item"><strong>Faltam</strong>${Finance.fmt(Math.max(0, remaining))}</div>
          <div class="goal-meta-item"><strong>Prazo</strong>${monthsLeft}</div>
          <div class="goal-meta-item"><strong>Aporte/mês</strong>${monthly}</div>
        </div>
        <div style="margin-top:12px;display:flex;gap:6px">
          <button class="btn-icon" onclick="App.editGoal('${g.id}')" title="Editar">✎</button>
          <button class="btn-icon delete" onclick="App.deleteGoal('${g.id}')" title="Excluir">✕</button>
        </div>
      </div>`;
    }).join('');
  },

  forecast() {
    const fc = Finance.forecast(State.transactions, 3);
    UI.set('fc-income',  Finance.fmt(fc.projIncomeTotal));
    UI.set('fc-expense', Finance.fmt(fc.projExpenseTotal));
    UI.set('fc-balance', Finance.fmt(fc.projBalanceDelta));
    const growthEl = UI.$('fc-growth');
    if (growthEl) {
      growthEl.textContent = Finance.fmtPct(fc.growthRate);
      growthEl.className = `fc-value ${fc.growthRate >= 0 ? 'positive' : 'negative'}`;
    }

    // Insights analíticos
    const insightsEl = UI.$('forecast-insights');
    if (insightsEl) {
      const burnRate = Finance.calcBurnRate(State.transactions);
      const periodTxs = Finance.filterByPeriod(State.transactions, 'current');
      const metrics = Finance.calcMetrics(periodTxs);
      const insights = [];

      if (metrics.savingsRate >= 20) {
        insights.push({ level: 'ok', title: 'Taxa de Poupança Saudável', body: `Você está poupando ${Finance.fmtPct(metrics.savingsRate)} da receita, acima do recomendado de 20% (regra 50/30/20).` });
      } else if (metrics.savingsRate < 0) {
        insights.push({ level: 'danger', title: 'Déficit Operacional', body: `Suas despesas superam a receita em ${Finance.fmtPct(Math.abs(metrics.savingsRate))}. Intervenção imediata necessária.` });
      } else {
        insights.push({ level: 'warning', title: 'Taxa de Poupança Abaixo do Ideal', body: `Poupança atual de ${Finance.fmtPct(metrics.savingsRate)}. Meta recomendada: mínimo 20% da receita.` });
      }

      const runway = Finance.calcRunway(metrics.balance, burnRate);
      if (isFinite(runway)) {
        const level = runway > 6 ? 'ok' : runway > 3 ? 'warning' : 'danger';
        insights.push({ level, title: 'Runway de Liquidez', body: `Com o saldo atual e burn rate de ${Finance.fmt(Math.round(burnRate))}/mês, você tem ${runway.toFixed(1).replace('.', ',')} meses de runway. ${runway < 3 ? 'Atenção crítica necessária.' : runway < 6 ? 'Recomenda-se ampliar reservas.' : 'Posição confortável.'}` });
      }

      if (fc.growthRate > 5) {
        insights.push({ level: 'ok', title: 'Tendência de Crescimento', body: `Projeção indica crescimento de ${Finance.fmtPct(fc.growthRate)} na receita. Mantenha a disciplina orçamentária.` });
      } else if (fc.growthRate < -5) {
        insights.push({ level: 'danger', title: 'Tendência de Queda na Receita', body: `Projeção indica redução de ${Finance.fmtPct(Math.abs(fc.growthRate))} na receita. Revise fontes de entrada.` });
      }

      insightsEl.innerHTML = insights.map(i => `
        <div class="insight-card ${i.level}-insight">
          <div class="insight-title">${i.title}</div>
          ${i.body}
        </div>`).join('');
    }

    Charts.buildForecast(State.transactions);
  },

  alertsView() {
    const list = UI.$('alerts-list');
    if (!list) return;

    if (State.alerts.length === 0) {
      list.innerHTML = '<div class="empty-state">Nenhum alerta configurado</div>';
    } else {
      const typeLabels = {
        saldo_min:   '◬ Saldo Mínimo',
        despesa_cat: '◉ Despesa por Categoria',
        burnrate:    '⇄ Burn Rate',
        savings_rate:'◎ Taxa de Poupança',
      };
      list.innerHTML = State.alerts.map(a => {
        const cat = State.categories.find(c => c.id === a.category_id);
        const desc = a.type === 'despesa_cat'
          ? `Categoria: ${cat?.name || '—'} • Limite: ${Finance.fmt(Finance.toCents(a.threshold))}`
          : a.type === 'savings_rate'
            ? `Mínimo: ${a.threshold}%`
            : `Limite: ${Finance.fmt(Finance.toCents(a.threshold))}`;
        return `<div class="alert-config-card">
          <span class="alert-config-icon">◬</span>
          <div class="alert-config-info">
            <div class="alert-config-name">${a.name || typeLabels[a.type]}</div>
            <div class="alert-config-desc">${typeLabels[a.type]} • ${desc}</div>
          </div>
          <div class="alert-config-actions">
            <button class="btn-icon delete" onclick="App.deleteAlert('${a.id}')" title="Remover">✕</button>
          </div>
        </div>`;
      }).join('');
    }

    // Active alerts
    const periodTxs = Finance.filterByPeriod(State.transactions, State.period);
    const metrics = Finance.calcMetrics(periodTxs);
    const burnRate = Finance.calcBurnRate(State.transactions);
    const triggered = Finance.checkAlerts(metrics, burnRate);

    const section = UI.$('active-alerts-section');
    const activeList = UI.$('active-alerts-list');
    if (section && activeList) {
      if (triggered.length > 0) {
        section.style.display = 'block';
        activeList.innerHTML = triggered.map(t =>
          `<div class="active-alert-item ${t.level}">⚠ ${t.label}</div>`
        ).join('');
      } else {
        section.style.display = 'none';
      }
    }
  },

  _txItem(t) {
    const cat = State.categories.find(c => c.id === t.category_id);
    const isIncome = t.type === 'income';
    return `<div class="tx-item">
      <span class="tx-dot" style="background:${cat?.color || (isIncome ? '#34d399' : '#f87171')}"></span>
      <div class="tx-info">
        <div class="tx-desc">${t.description}</div>
        <div class="tx-cat">${cat?.name || '—'} • ${UI.fmtDate(t.date)}</div>
      </div>
      <span class="tx-amount ${isIncome ? 'income' : 'expense'}">${Finance.fmt(t.amount_cents)}</span>
    </div>`;
  },

  all() {
    UI.populateCategorySelects();
    this.dashboard();
    this.transactions();
    this.categories();
    this.goals();
    this.forecast();
    this.alertsView();
  },
};

/* ============================================================
   APP — Controller principal
   ============================================================ */
const App = {

  init() {
    Storage.load();
    this._seedDefaultCategories();
    Charts.defaults();
    UI.updateDate();
    this._bindEvents();
    this._setTodayDate();
    Render.all();
    this._registerSW();

    // Atualiza data a cada minuto
    setInterval(() => UI.updateDate(), 60000);
  },

  _seedDefaultCategories() {
    if (State.categories.length > 0) return;
    const defaults = [
      { name: 'Moradia',       type: 'expense', color: '#f87171' },
      { name: 'Alimentação',   type: 'expense', color: '#fb923c' },
      { name: 'Transporte',    type: 'expense', color: '#facc15' },
      { name: 'Saúde',         type: 'expense', color: '#4ade80' },
      { name: 'Lazer',         type: 'expense', color: '#60a5fa' },
      { name: 'Educação',      type: 'expense', color: '#a78bfa' },
      { name: 'Outros',        type: 'both',    color: '#94a3b8' },
      { name: 'Salário',       type: 'income',  color: '#34d399' },
      { name: 'Freelance',     type: 'income',  color: '#22d3ee' },
      { name: 'Investimentos', type: 'income',  color: '#818cf8' },
    ];
    defaults.forEach(d => {
      State.categories.push({ id: genId(), budget_cents: 0, ...d });
    });
    Storage.save();
  },

  _setTodayDate() {
    const today = new Date().toISOString().split('T')[0];
    const el = UI.$('tx-date');
    if (el) el.value = today;
  },

  _bindEvents() {
    // Navegação sidebar
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        const view = item.dataset.view;
        if (view) this.switchView(view);
      });
    });

    // Panel links
    document.querySelectorAll('.panel-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const view = link.dataset.view;
        if (view) this.switchView(view);
      });
    });

    // Sidebar toggle (mobile)
    UI.$('sidebar-toggle')?.addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('open');
    });

    // Period
    UI.$('period-select')?.addEventListener('change', e => {
      State.period = e.target.value;
      Render.all();
    });

    // Open modal buttons
    ['btn-open-modal', 'btn-open-modal-2'].forEach(id => {
      UI.$(id)?.addEventListener('click', () => this.openTxModal());
    });

    // Transaction modal
    UI.$('modal-close')?.addEventListener('click',  () => this.closeTxModal());
    UI.$('modal-cancel')?.addEventListener('click', () => this.closeTxModal());
    UI.$('modal-overlay')?.addEventListener('click', e => { if (e.target === UI.$('modal-overlay')) this.closeTxModal(); });
    UI.$('modal-save')?.addEventListener('click', () => this.saveTransaction());

    // Type toggle
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const input = UI.$('tx-type');
        if (input) input.value = btn.dataset.type;
      });
    });

    // Category modal
    UI.$('btn-add-category')?.addEventListener('click',  () => this.openCatModal());
    UI.$('cat-modal-close')?.addEventListener('click',   () => UI.closeModal('cat-modal-overlay'));
    UI.$('cat-modal-cancel')?.addEventListener('click',  () => UI.closeModal('cat-modal-overlay'));
    UI.$('cat-modal-overlay')?.addEventListener('click', e => { if (e.target === UI.$('cat-modal-overlay')) UI.closeModal('cat-modal-overlay'); });
    UI.$('cat-modal-save')?.addEventListener('click',    () => this.saveCategory());

    // Goal modal
    UI.$('btn-add-goal')?.addEventListener('click',      () => this.openGoalModal());
    UI.$('goal-modal-close')?.addEventListener('click',  () => UI.closeModal('goal-modal-overlay'));
    UI.$('goal-modal-cancel')?.addEventListener('click', () => UI.closeModal('goal-modal-overlay'));
    UI.$('goal-modal-overlay')?.addEventListener('click',e => { if (e.target === UI.$('goal-modal-overlay')) UI.closeModal('goal-modal-overlay'); });
    UI.$('goal-modal-save')?.addEventListener('click',   () => this.saveGoal());

    // Alert modal
    UI.$('btn-add-alert')?.addEventListener('click',      () => UI.openModal('alert-modal-overlay'));
    UI.$('alert-modal-close')?.addEventListener('click',  () => UI.closeModal('alert-modal-overlay'));
    UI.$('alert-modal-cancel')?.addEventListener('click', () => UI.closeModal('alert-modal-overlay'));
    UI.$('alert-modal-overlay')?.addEventListener('click',e => { if (e.target === UI.$('alert-modal-overlay')) UI.closeModal('alert-modal-overlay'); });
    UI.$('alert-modal-save')?.addEventListener('click',   () => this.saveAlert());

    // Filters
    ['filter-type', 'filter-cat', 'filter-search'].forEach(id => {
      UI.$(id)?.addEventListener('input', () => Render.transactions());
      UI.$(id)?.addEventListener('change', () => Render.transactions());
    });
  },

  switchView(view) {
    State.activeView = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const viewEl = UI.$(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (navEl) navEl.classList.add('active');

    const titles = {
      dashboard: 'Dashboard Executivo',
      transactions: 'Registro de Transações',
      categories: 'Gestão de Categorias',
      goals: 'Metas Financeiras',
      forecast: 'Projeções e Forecast',
      alerts: 'Central de Alertas',
    };
    UI.set('view-title', titles[view] || 'FinFlow');

    // Render view específica
    if (view === 'dashboard')    { Render.dashboard(); }
    if (view === 'transactions') { Render.transactions(); }
    if (view === 'categories')   { Render.categories(); }
    if (view === 'goals')        { Render.goals(); }
    if (view === 'forecast')     { Render.forecast(); }
    if (view === 'alerts')       { Render.alertsView(); }

    // Fecha sidebar mobile
    document.getElementById('sidebar').classList.remove('open');
  },

  // ── TRANSACTIONS ──
  openTxModal(tx = null) {
    this._setTodayDate();
    UI.$('tx-edit-id').value = tx?.id || '';
    UI.$('tx-description').value = tx?.description || '';
    UI.$('tx-amount').value = tx ? (tx.amount_cents / 100).toFixed(2) : '';
    UI.$('tx-category').value = tx?.category_id || '';
    UI.$('tx-notes').value = tx?.notes || '';
    UI.$('tx-fixed').checked = tx?.fixed || false;
    if (tx?.date) UI.$('tx-date').value = tx.date;

    const type = tx?.type || 'expense';
    UI.$('tx-type').value = type;
    document.querySelectorAll('.type-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.type === type);
    });

    UI.$('modal-tx-title').textContent = tx ? 'Editar Transação' : 'Nova Transação';
    UI.populateCategorySelects();
    if (tx?.category_id) UI.$('tx-category').value = tx.category_id;
    UI.openModal('modal-overlay');
  },

  closeTxModal() {
    UI.closeModal('modal-overlay');
    UI.$('tx-edit-id').value = '';
  },

  saveTransaction() {
    const desc   = UI.$('tx-description').value.trim();
    const amount = parseFloat(UI.$('tx-amount').value);
    const date   = UI.$('tx-date').value;
    const type   = UI.$('tx-type').value;

    if (!desc)         return UI.toast('Informe uma descrição.', 'error');
    if (!amount || amount <= 0) return UI.toast('Valor deve ser maior que zero.', 'error');
    if (!date)         return UI.toast('Selecione uma data.', 'error');

    const editId = UI.$('tx-edit-id').value;
    const tx = {
      id:          editId || genId(),
      type,
      amount_cents: Finance.toCents(amount),
      description: desc,
      category_id: UI.$('tx-category').value || null,
      date,
      notes:       UI.$('tx-notes').value.trim(),
      fixed:       UI.$('tx-fixed').checked,
    };

    if (editId) {
      const idx = State.transactions.findIndex(t => t.id === editId);
      if (idx !== -1) State.transactions[idx] = tx;
    } else {
      State.transactions.push(tx);
    }

    Storage.save();
    this.closeTxModal();
    UI.toast(editId ? 'Transação atualizada.' : 'Transação registrada.', 'success');
    Render.all();
  },

  editTransaction(id) {
    const tx = State.transactions.find(t => t.id === id);
    if (tx) this.openTxModal(tx);
  },

  deleteTransaction(id) {
    if (!confirm('Excluir esta transação?')) return;
    State.transactions = State.transactions.filter(t => t.id !== id);
    Storage.save();
    UI.toast('Transação excluída.', 'success');
    Render.all();
  },

  // ── CATEGORIES ──
  openCatModal(cat = null) {
    UI.$('cat-edit-id').value = cat?.id || '';
    UI.$('cat-name').value    = cat?.name || '';
    UI.$('cat-type').value    = cat?.type || 'expense';
    UI.$('cat-color').value   = cat?.color || '#4ade80';
    UI.$('cat-budget').value  = cat ? (cat.budget_cents / 100).toFixed(2) : '';
    UI.openModal('cat-modal-overlay');
  },

  saveCategory() {
    const name  = UI.$('cat-name').value.trim();
    const color = UI.$('cat-color').value;
    const type  = UI.$('cat-type').value;
    const budget = parseFloat(UI.$('cat-budget').value) || 0;

    if (!name) return UI.toast('Informe o nome da categoria.', 'error');

    const editId = UI.$('cat-edit-id').value;
    const cat = {
      id:           editId || genId(),
      name, type, color,
      budget_cents: Finance.toCents(budget),
    };

    if (editId) {
      const idx = State.categories.findIndex(c => c.id === editId);
      if (idx !== -1) State.categories[idx] = cat;
    } else {
      State.categories.push(cat);
    }

    Storage.save();
    UI.closeModal('cat-modal-overlay');
    UI.toast('Categoria salva.', 'success');
    Render.all();
  },

  editCategory(id) {
    const cat = State.categories.find(c => c.id === id);
    if (cat) this.openCatModal(cat);
  },

  deleteCategory(id) {
    if (!confirm('Excluir categoria? As transações vinculadas perderão a categorização.')) return;
    State.categories = State.categories.filter(c => c.id !== id);
    State.transactions.forEach(t => { if (t.category_id === id) t.category_id = null; });
    Storage.save();
    UI.toast('Categoria excluída.', 'success');
    Render.all();
  },

  // ── GOALS ──
  openGoalModal(goal = null) {
    UI.$('goal-edit-id').value   = goal?.id || '';
    UI.$('goal-name').value      = goal?.name || '';
    UI.$('goal-target').value    = goal ? (goal.target_cents / 100).toFixed(2) : '';
    UI.$('goal-current').value   = goal ? (goal.current_cents / 100).toFixed(2) : '';
    UI.$('goal-deadline').value  = goal?.deadline || '';
    UI.$('goal-priority').value  = goal?.priority || 'medium';
    UI.openModal('goal-modal-overlay');
  },

  saveGoal() {
    const name    = UI.$('goal-name').value.trim();
    const target  = parseFloat(UI.$('goal-target').value);
    const current = parseFloat(UI.$('goal-current').value) || 0;

    if (!name)   return UI.toast('Informe o nome da meta.', 'error');
    if (!target || target <= 0) return UI.toast('Valor alvo deve ser maior que zero.', 'error');

    const editId = UI.$('goal-edit-id').value;
    const goal = {
      id:            editId || genId(),
      name,
      target_cents:  Finance.toCents(target),
      current_cents: Finance.toCents(current),
      deadline:      UI.$('goal-deadline').value || null,
      priority:      UI.$('goal-priority').value,
    };

    if (editId) {
      const idx = State.goals.findIndex(g => g.id === editId);
      if (idx !== -1) State.goals[idx] = goal;
    } else {
      State.goals.push(goal);
    }

    Storage.save();
    UI.closeModal('goal-modal-overlay');
    UI.toast('Meta salva.', 'success');
    Render.all();
  },

  editGoal(id) {
    const goal = State.goals.find(g => g.id === id);
    if (goal) this.openGoalModal(goal);
  },

  deleteGoal(id) {
    if (!confirm('Excluir esta meta?')) return;
    State.goals = State.goals.filter(g => g.id !== id);
    Storage.save();
    UI.toast('Meta excluída.', 'success');
    Render.all();
  },

  // ── ALERTS ──
  saveAlert() {
    const type      = UI.$('alert-type').value;
    const threshold = parseFloat(UI.$('alert-threshold').value);
    const name      = UI.$('alert-name').value.trim();
    const catId     = UI.$('alert-cat').value;

    if (!threshold && threshold !== 0) return UI.toast('Informe o valor limite.', 'error');

    State.alerts.push({
      id: genId(), type, threshold, name,
      category_id: catId || null,
    });

    Storage.save();
    UI.closeModal('alert-modal-overlay');
    UI.toast('Alerta configurado.', 'success');
    Render.alertsView();
  },

  deleteAlert(id) {
    State.alerts = State.alerts.filter(a => a.id !== id);
    Storage.save();
    UI.toast('Alerta removido.', 'success');
    Render.alertsView();
  },

  // ── SERVICE WORKER ──
  _registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('FinFlow SW registered'))
        .catch(e => console.warn('SW error:', e));
    }
  },
};

/* ── BOOT ── */
document.addEventListener('DOMContentLoaded', () => App.init());
