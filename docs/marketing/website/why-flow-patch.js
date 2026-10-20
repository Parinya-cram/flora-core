(function(){
  function pair(th,en){return '<span class="th">'+th+'</span><span class="en">'+en+'</span>'}
  function renderWhy(){
    var why=document.querySelector('main > .section');
    if(!why)return;
    why.classList.add('why-flora');
    why.innerHTML='<div class="wrap why-story">'
      +'<header class="why-lead"><span class="kicker">Why FLORA</span><h2>'+pair('จุดเด่นไม่ใช่แค่เชื่อมข้อมูล<br><em>แต่คือทำให้ข้อมูลไปต่อได้</em>','More than connected data.<br><em>Clinical information that keeps moving.</em>')+'</h2><p>'+pair('FLORA บันทึกข้อมูลที่สถานีข้างเตียงก่อน จึงไม่ต้องรอระบบส่วนกลาง เมื่อเครือข่ายกลับมา ข้อมูลจึงค่อยซิงก์และรวมเป็น timeline เดียวที่ตรวจสอบย้อนหลังได้','FLORA records at the bedside first, without waiting for the central system. When connectivity returns, data syncs into one traceable timeline.')+'</p></header>'
      +'<div class="continuity-flow" aria-label="How FLORA keeps clinical information continuous"><div class="flow-rail" aria-hidden="true"><i></i></div>'
      +'<article><span class="flow-index">01</span><div class="flow-copy"><span class="flow-place">'+pair('ที่จุดดูแล','At the bedside')+'</span><h3>'+pair('บันทึกลง Leaf ทันที','Record to Leaf immediately')+'</h3><p>'+pair('ค่าจากเครื่องมือ ยา สารน้ำ และเหตุการณ์ที่ทีมบันทึก ถูกเก็บในฐานข้อมูลข้างเตียงของเคสนั้น','Device values, medications, fluids and staff-entered events are stored in that case at the bedside.')+'</p></div><strong><span class="signal signal--live"></span>'+pair('ข้อมูลกำลังถูกบันทึก','Recording locally')+'</strong></article>'
      +'<article><span class="flow-index">02</span><div class="flow-copy"><span class="flow-place">'+pair('เมื่อเครือข่ายสะดุด','During an outage')+'</span><h3>'+pair('ทีมยังทำงานต่อ ข้อมูลยังอยู่','Care continues. Data stays.')+'</h3><p>'+pair('หน้าจอและการบันทึกหลักยังทำงานจากข้อมูลในพื้นที่ ลดความเสี่ยงที่เคสต้องหยุดหรือกลับไปจดบนกระดาษ','Core charting continues from local data, reducing the risk of interrupted cases or fallback transcription.')+'</p></div><strong><span class="signal signal--local"></span>'+pair('ไม่รอส่วนกลาง','No central wait')+'</strong></article>'
      +'<article><span class="flow-index">03</span><div class="flow-copy"><span class="flow-place">'+pair('เมื่อเชื่อมต่ออีกครั้ง','After reconnection')+'</span><h3>'+pair('ซิงก์ขึ้น Canopy เป็นเคสเดียวกัน','Sync to Canopy as one case')+'</h3><p>'+pair('ข้อมูลจากเครื่องและข้อมูลที่ทีมบันทึกกลับมารวมตามเวลา พร้อมแยกที่มาและมีประวัติการเปลี่ยนแปลงสำหรับทบทวน','Device and staff-entered data reunite chronologically, with source distinction and change history for review.')+'</p></div><strong><span class="signal signal--sync"></span>'+pair('ซิงก์อัตโนมัติ','Automatic sync')+'</strong></article></div>'
      +'<footer class="why-outcome"><span><b>01</b>'+pair('ข้อมูลไม่หายเมื่อเครือข่ายไม่พร้อม','Data remains available during outages')+'</span><span><b>02</b>'+pair('ลดการจดและกรอกข้อมูลซ้ำ','Less duplicate transcription')+'</span><span><b>03</b>'+pair('เห็นหนึ่งเคสต่อเนื่องและตรวจสอบได้','One continuous, traceable case')+'</span></footer></div>';
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',renderWhy);
  else renderWhy();
})();
