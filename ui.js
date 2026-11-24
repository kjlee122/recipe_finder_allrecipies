"use strict";
(() => {
  const tabs=[...document.querySelectorAll('[data-tab]')];
  const panels=[...document.querySelectorAll('[data-panel]')];
  const calendar=document.getElementById('two-week-calendar');
  function showTab(tab){
    tabs.forEach(b=>{const on=b.dataset.tab===tab;b.classList.toggle('is-active',on);b.setAttribute('aria-current',on?'page':'false')});
    panels.forEach(p=>{p.hidden=p.dataset.panel!==(tab==='week2'?'week1':tab)});
    if(tab==='week1'||tab==='week2'){
      const w=tab==='week1'?'1':'2';calendar.dataset.activeWeek=w;
      document.getElementById('calendar-heading').innerHTML='Week '+w+' <span class="subtle-heading">· Your meal calendar</span>';
    }
    if(tab==='insights'){
      const insights=document.getElementById('plan-analysis');
      if(insights) insights.hidden=false;
      if(typeof renderTwoWeekInsights==='function')renderTwoWeekInsights();
      if(insights) insights.hidden=false;
    }
  }
  tabs.forEach(b=>b.addEventListener('click',()=>showTab(b.dataset.tab)));
  const observer=new MutationObserver(()=>{if(calendar.children.length && document.querySelector('[data-panel="plan"]:not([hidden])'))showTab('week1')});
  observer.observe(calendar,{childList:true});
  showTab('plan');
})();
