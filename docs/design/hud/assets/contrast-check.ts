type RGB=[number,number,number];
const toLin=(c:number)=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;
const lum=([r,g,b]:RGB)=>0.2126*toLin(r)+0.7152*toLin(g)+0.0722*toLin(b);
const ratio=(a:RGB,b:RGB)=>{const[x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
const over=(fg:RGB,a:number,bg:RGB):RGB=>fg.map((c,i)=>c*a+bg[i]*(1-a)) as RGB;
const hex=(c:RGB)=>'#'+c.map(v=>Math.round(Math.max(0,Math.min(1,v))*255).toString(16).padStart(2,'0')).join('');
const un=(h:string):RGB=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255) as RGB;
const glass=un('#0f141c');
const beds:[string,RGB][]=[['night',un('#0d0f14')],['asphalt',un('#2e2e33')],['grass',un('#266b2e')],['sunlit',un('#bfbfb8')],['white',un('#ffffff')]];
console.log('bed | glass@.80 | hover w.08 | press w.16 | sel a.35 | ratios hover/press vs glass, press vs hover');
for(const [n,w] of beds){
  const g=over(glass,0.80,w); const h=over([1,1,1],0.08,g); const p=over([1,1,1],0.16,g); const s=over(un('#5c9eff'),0.35,g);
  console.log(`${n.padEnd(8)} ${hex(g)} ${hex(h)} ${hex(p)} ${hex(s)} | h/g ${ratio(h,g).toFixed(2)} p/g ${ratio(p,g).toFixed(2)} p/h ${ratio(p,h).toFixed(2)} sel/g ${ratio(s,g).toFixed(2)} ink/sel ${ratio(un('#f2f5fa'),s).toFixed(2)}`);
}
console.log('\nglass@.92 (tooltip) over each bed: ink / muted / negative');
for(const [n,w] of beds){const g=over(glass,0.92,w);console.log(`${n.padEnd(8)} ${hex(g)} ink ${ratio(un('#f2f5fa'),g).toFixed(2)} muted ${ratio(un('#b3bac7'),g).toFixed(2)} negative ${ratio(un('#ff736b'),g).toFixed(2)} positive ${ratio(un('#73d98c'),g).toFixed(2)} warning ${ratio(un('#ffc74d'),g).toFixed(2)} accent-ink ${ratio(un('#a8ceff'),g).toFixed(2)} disabled ${ratio(un('#9aa1ac'),g).toFixed(2)}`);}
console.log('\nglass@.80 over each bed: ink / muted / disabled / accent-ink / pos / neg / warn');
for(const [n,w] of beds){const g=over(glass,0.80,w);console.log(`${n.padEnd(8)} ${hex(g)} ink ${ratio(un('#f2f5fa'),g).toFixed(2)} muted ${ratio(un('#b3bac7'),g).toFixed(2)} disabled ${ratio(un('#9aa1ac'),g).toFixed(2)} accent-ink ${ratio(un('#a8ceff'),g).toFixed(2)} pos ${ratio(un('#73d98c'),g).toFixed(2)} neg ${ratio(un('#ff736b'),g).toFixed(2)} warn ${ratio(un('#ffc74d'),g).toFixed(2)}`);}
