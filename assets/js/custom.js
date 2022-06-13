var swap_pseudonym = function(t, e, p) {
    current_pseudonym = p;
    idx = e.findIndex(item => item.name == current_pseudonym);
    next_pseudonym = e[(idx + 1) % (e.length - 1)];
    //change pseudonym text
    t.style.content = next_pseudonym.name;
    t.setAttribute("data-text", next_pseudonym.name);
    t.innerText = next_pseudonym.name;
    //change pseudonym color
    document.documentElement.style.setProperty('--pseudonym-color', next_pseudonym.color);
};

$(document).ready(function() {
	document.getElementsByClassName("highlight-title")[0].onclick = function(e) {
	    var e = this.getAttribute("data-rotate"),
	        p = this.getAttribute("data-text");
	    swap_pseudonym(this, JSON.parse(e), p);
	};
});