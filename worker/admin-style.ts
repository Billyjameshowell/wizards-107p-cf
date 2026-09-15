/** Shared traditional stats-sheet presentation for status and sign-in. */
export const ADMIN_STYLE = `
:root{font-family:Arial,Helvetica,sans-serif;color:#162536;background:#f1f2f3;color-scheme:light}
*{box-sizing:border-box}body{margin:0;font-size:12px;line-height:1.35}a,a:visited{color:#07569b;text-decoration:none}a:hover{color:#b51232;text-decoration:underline}
a:focus-visible,input:focus-visible,button:focus-visible,[tabindex]:focus-visible{outline:2px solid #c8102e;outline-offset:2px}
main{max-width:1320px;margin:12px auto;padding:0 16px 14px;border:1px solid #b7bec5;background:white}
.masthead{border-top:5px solid #002b5c;border-bottom:3px solid #c8102e;padding:12px 0 8px;display:flex;justify-content:space-between;align-items:end;gap:12px}
.brand{display:flex;align-items:center;gap:10px}.brand img{width:44px;height:44px}.brand-title{font:bold italic 32px Georgia,'Times New Roman',serif;color:#002b5c;letter-spacing:-1px;line-height:1}.brand-title span{color:#c8102e}
.brand p{font-size:10px;letter-spacing:.6px;margin:5px 0 0}.masthead nav{font-size:11px;font-weight:bold;white-space:nowrap}
h1{font-size:14px;margin:12px 0 3px;color:#002b5c;text-transform:uppercase}h2{margin:14px 0 6px;padding:4px 7px;background:#002b5c;color:white;font-size:11px;letter-spacing:.4px;text-transform:uppercase}h2.accent{background:#a11d35}
p{margin:5px 0}.muted{color:#56616d;font-size:11px}.meta{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;border-bottom:1px solid #ccd3d9;padding-bottom:6px}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;border-top:1px solid #b7c4cf;border-left:1px solid #b7c4cf}
.facts div{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:5px 8px;border-bottom:1px solid #b7c4cf;border-right:1px solid #b7c4cf;background:#edf1f5;font-size:11px}
dt{color:#536272}dd{margin:0;font-weight:bold;text-align:right;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;border:1px solid #788b9e;margin:6px 0}table{width:100%;border-collapse:collapse;min-width:850px;font-size:11px}th,td{padding:4px 7px;text-align:left;border-right:1px solid #ccd3d9;border-bottom:1px solid #ccd3d9;vertical-align:middle}
thead th{background:#345472;color:white;font-size:10px;white-space:nowrap}tbody th{font-weight:bold;color:#002b5c}tbody tr:nth-child(even){background:#edf0f3}tbody tr:hover{background:#fff7dc}.prices td:nth-child(n+4):nth-child(-n+7){text-align:right;font-variant-numeric:tabular-nums}.prices td:last-child{white-space:nowrap;font-size:10px}
.team-logo{width:16px;height:16px;vertical-align:middle;object-fit:contain;margin-right:5px}.team-name{white-space:nowrap;color:#07569b;font-weight:bold}.state-on{color:#126b48}.state-off{color:#59636e}.missing-key,.error{color:#a91532}.source-notes{padding-left:18px;font-size:11px;color:#59636e;margin:6px 0}
footer{border-top:1px solid #c4cbd2;margin-top:12px;padding-top:7px;font-size:10px;color:#646d76}
.login-sheet{max-width:760px}.login-panel{max-width:390px;margin:20px 0 25px}label{display:block;font-size:12px;margin-top:10px}input,button{font:inherit}input[type=password]{display:block;width:100%;margin:5px 0;padding:6px;border:1px solid #8799aa;border-radius:0}.remember{display:flex;align-items:center;gap:5px;font-size:11px}.remember input{accent-color:#002b5c}button{margin-top:12px;padding:5px 18px;border:1px solid #002b5c;background:#002b5c;color:white;cursor:pointer;border-radius:0}button:hover{background:#a11d35}.error{border-left:3px solid #a91532;padding-left:8px}
@media(max-width:700px){main{margin:0;border-left:0;border-right:0;padding:0 8px 12px}.masthead{align-items:start;flex-direction:column;gap:6px}.brand-title{font-size:27px}.masthead nav{align-self:flex-end}.facts{grid-template-columns:1fr}.login-panel{max-width:100%}.meta{font-size:10px}}
`;
export const ADMIN_MASTHEAD = `<header class="masthead"><div class="brand"><img src="/team-logos/was.svg" width="44" height="44" alt=""><div><div class="brand-title">WIZARDS <span>107P</span></div><p>SEASON TICKET BOOK · ADMINISTRATION</p></div></div><nav aria-label="Page navigation"><a href="/">Ticket book</a> | <a href="/admin">Admin status</a> | <a href="/admin/login">Sign in</a></nav></header>`;
