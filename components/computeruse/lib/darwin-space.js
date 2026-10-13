/** Mission Control Spaces share physical input. Bind a user-selected window, never a VM. */
export const SPACE_INPUT_POLICY=Object.freeze({idleMs:100,maxWaitMs:5000,restoreCursor:true,restoreFocus:true,userInputBlocked:false});
export const SPACE_ACTIONS=['app_list','observe','app_observe','takeover_start','takeover_stop','app_activate','app_click','app_type','app_key','app_scroll','sequence','wait','mode_report'];
export const wantsSpace=input=>input.mode==='virtual'||input.mouseMode==='virtual'||input.desktop==='space'||input.action==='takeover_start'&&input.mouseMode!=='real'&&input.mode!=='real';
export function validateSpaceRequest(input){
 if(input.desktop && input.desktop!=='space'||input.desktopName)return{ok:false,code:'unsupported_space_desktop',error_code:'unsupported_space_desktop',error:'macOS uses a window-bound Mission Control Space; hidden desktops/VMs are not this route'};
 if(['click','move','type','scroll','key'].includes(input.action)&&input.mouseMode!=='real')return{ok:false,code:'unsafe_space_action',error_code:'unsafe_space_action',error:'Unscoped Space input is disabled; normal CU must explicitly use mouse_mode real'};
 if(!wantsSpace(input))return null;
 if(!SPACE_ACTIONS.includes(input.action))return{ok:false,code:'unsafe_space_action',error_code:'unsafe_space_action',error:'Space shares user input; use app_* actions on the bound window'};
 if(input.action==='takeover_start'&&!/^mac:\d+:\d+$/.test(input.windowHandle||''))return{ok:false,code:'space_target_required',error_code:'space_target_required',error:'Place the target window in the intended Space and supply its fresh window_handle'};
 return null;
}
export function createSpaceDispatch(dispatch){
 const bindings=new Map();
 return{async run(input){
  const owner=String(input.ownerId||''),bound=bindings.get(owner),space=wantsSpace(input)||Boolean(bound),request={...input};
  if(space){request.spaceMode=true;request.windowHandle||=bound;if(bound&&request.windowHandle!==bound)return{ok:false,error_code:'space_target_mismatch',action_applied:false};const refusal=validateSpaceRequest({...request,mouseMode:'virtual'});if(refusal)return refusal;}
  const result=await dispatch(request);
  if(result.ok&&input.action==='takeover_start'&&space)bindings.set(owner,request.windowHandle);
  if(result.ok&&input.action==='takeover_stop')bindings.delete(owner);
  return result;
 },clear(){bindings.clear();},size:()=>bindings.size};
}
