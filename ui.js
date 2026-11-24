"use strict";
(() => {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const panels = [...document.querySelectorAll('[data-panel]')];
  function showTab(tab) {
    tabs.forEach(b => { const active=b.dataset.tab===tab; b.classList.toggle('is-active',active);b.setAttribute('aria-current',active?'page':'false'); });
    panels.forEach(p => { p.hidden = p.dataset.panel!==tab; });
    // The analysis panel is populated by the planner only when available.
    if(tab==='insights' && !document.getElementById('optimized-count').textContent.trim().replace('—','')) {
      const panel=document.getElementById('plan-analysis');
      panel.hidden=false;
    }
  }
  tabs.forEach(b=>b.addEventListener('click',()=>showTab(b.dataset.tab)));
  const weekButtons=[...document.querySelectorAll('[data-week]')];
  function showWeek(week) {
    const calendar=document.getElementById('two-week-calendar');
    calendar.dataset.activeWeek=week;
    weekButtons.forEach(b=>b.classList.toggle('is-active',b.dataset.week===week));
  }
  weekButtons.forEach(b=>b.addEventListener('click',()=>showWeek(b.dataset.week)));
  showWeek('1');showTab('plan');
  const calendar=document.getElementById('two-week-calendar');
  const observer=new MutationObserver(()=>{
    if(calendar.children.length && document.querySelector('[data-panel="plan"]:not([hidden])')) showTab('calendar');
  });
  observer.observe(calendar,{childList:true});
})();
