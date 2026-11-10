fn sum(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    println!("{}", sum(2, 3));
}

#[cfg(test)]
mod tests {
    #[test]
    fn adds() {
        assert_eq!(super::sum(2, 3), 5);
    }
}
